#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { SuinsClient, SuinsTransaction, ALLOWED_METADATA } from '@mysten/suins';
import { Transaction } from '@mysten/sui/transactions';
import { kiosk, KioskTransaction } from '@mysten/kiosk';

const suiClient = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('mainnet') }).$extend(kiosk());
const suinsClient = new SuinsClient({ client: suiClient, network: 'mainnet' });

// SuiNS NFT type for kiosk operations
const SUINS_NFT_TYPE = `${suinsClient.config.packageIdV1}::registration::SuinsRegistration`;

function createServer() {
    const server = new McpServer({ name: 'suins-mcp', version: '1.0.1' });

    // QUERY TOOLS

    server.tool('resolve_name',
    'Resolve a .sui name to a wallet address',
    { name: z.string().describe('The .sui name to resolve e.g. ossy.sui') },
    async ({ name }) => {
        try {
            const address = await suiClient.resolveNameServiceAddress({ name });
            if (!address) return mcpResponse({ error: `Name "${name}" not found or has no address` });
            return mcpResponse({ name, address });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    server.tool('reverse_lookup',
    'Find the .sui name(s) for a wallet address',
    { address: z.string().describe('The Sui wallet address to look up') },
    async ({ address }) => {
        try {
            const result = await suiClient.resolveNameServiceNames({ address });
            if (!result?.data?.length) return mcpResponse({ error: `No .sui name found for "${address}"` });
            return mcpResponse({ address, names: result.data });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    server.tool('get_name_record',
    'Get full details of a .sui name including expiry, avatar, and content hash',
    { name: z.string().describe('The .sui name to get details for') },
    async ({ name }) => {
        try {
            const record = await suinsClient.getNameRecord(name);
            if (!record) return mcpResponse({ error: `Name "${name}" not found` });
            return mcpResponse({
                name: record.name,
                address: record.targetAddress,
                expiration: record.expirationTimestampMs,
                avatar: record.avatar,
                contentHash: record.contentHash,
                walrusSiteId: record.walrusSiteId,
            });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    server.tool('check_availability',
    'Check if a .sui name is available to register',
    { name: z.string().describe('The .sui name to check e.g. myname.sui') },
    async ({ name }) => {
        try {
            const record = await suinsClient.getNameRecord(name);
            return mcpResponse({ name, available: !record });
        } catch {
            return mcpResponse({ name, available: true });
        }
    });

    server.tool('get_pricing',
    'Get current SuiNS registration pricing by name length in USDC, NS, and SUI',
    {},
    async () => {
        try {
            const priceList = await suinsClient.getPriceList();
            const USDC = formatPrices(priceList);
            return mcpResponse({
                USDC,
                SUI: 'calculated by Pyth oracle at tx execution time',
                NS: 'calculated by Pyth oracle at tx execution time (25% discount applied)',
                note: 'Only USDC prices are fixed. SUI and NS amounts are determined on-chain. See https://docs.suins.io/developer/sdk/querying',
            });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    server.tool('get_renewal_pricing',
    'Get current SuiNS renewal pricing by name length in USDC, NS, and SUI',
    {},
    async () => {
        try {
            const priceList = await suinsClient.getRenewalPriceList();
            const USDC = formatPrices(priceList);
            return mcpResponse({
                USDC,
                SUI: 'calculated by Pyth oracle at tx execution time',
                NS: 'calculated by Pyth oracle at tx execution time (25% discount applied)',
                note: 'Only USDC prices are fixed. SUI and NS amounts are determined on-chain. See https://docs.suins.io/developer/sdk/querying',
            });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    // TRANSACTION TOOLS

    server.tool('build_register_tx',
    'Build a transaction to register a new .sui name. Returns unsigned tx bytes to be signed and executed by the caller.',
    {
        name: z.string(),
        years: z.number().min(1).max(5),
        coin: z.string(),
        coinType: z.enum(['USDC', 'SUI', 'NS']),
        recipient: z.string(),
        sender: z.string(),
    },
    async ({ name, years, coin, coinType, recipient, sender }) => {
        try {
            const tx = new Transaction();
            tx.setSender(sender);
            const suinsTx = new SuinsTransaction(suinsClient, tx);
            const coinConfig = suinsClient.config.coins[coinType];

            let priceInfoObjectId;
            if (coinType !== 'USDC') {
                priceInfoObjectId = (await suinsClient.getPriceInfoObject(tx, coinConfig.feed))[0];
            }

            const nft = suinsTx.register({
                domain: name,
                years,
                coinConfig,
                coin,
                ...(priceInfoObjectId && { priceInfoObjectId }),
            });

            tx.transferObjects([nft], tx.pure.address(recipient));
            const txBytes = await tx.build({ client: suiClient });

            return mcpResponse({
                txBytes: Buffer.from(txBytes).toString('base64'),
                note: 'Sign and execute these tx bytes with your wallet',
            });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    server.tool('build_renew_tx',
    'Build a transaction to renew an existing .sui name. Returns unsigned tx bytes.',
    {
        name: z.string(),
        nftId: z.string(),
        years: z.number().min(1).max(5),
        coin: z.string(),
        coinType: z.enum(['USDC', 'SUI', 'NS']),
        sender: z.string(),
        kioskId: z.string().optional(),
        kioskOwnerCapId: z.string().optional(),
    },
    async ({ nftId, years, coin, coinType, sender, kioskId, kioskOwnerCapId }) => {
        try {
            const tx = new Transaction();
            tx.setSender(sender);
            const suinsTx = new SuinsTransaction(suinsClient, tx);
            const coinConfig = suinsClient.config.coins[coinType];

            let priceInfoObjectId;
            if (coinType !== 'USDC') {
                priceInfoObjectId = (await suinsClient.getPriceInfoObject(tx, coinConfig.feed))[0];
            }

            // Handle kiosk-owned NFTs
            let nftArg = nftId;
            let kioskTx;
            let borrowPromise;
            if (kioskId && kioskOwnerCapId) {
                kioskTx = new KioskTransaction({ transaction: tx, kioskClient: suiClient.kiosk });
                kioskTx.setKiosk(tx.object(kioskId)).setKioskCap(tx.object(kioskOwnerCapId));
                const [borrowedNft, promise] = kioskTx.borrow({ itemType: SUINS_NFT_TYPE, itemId: nftId });
                nftArg = borrowedNft;
                borrowPromise = promise;
            }

            suinsTx.renew({
                nft: nftArg,
                years,
                coinConfig,
                coin,
                ...(priceInfoObjectId && { priceInfoObjectId }),
            });

            // Return NFT to kiosk if borrowed
            if (kioskTx && borrowPromise) {
                kioskTx.return({ itemType: SUINS_NFT_TYPE, item: nftArg, promise: borrowPromise });
                kioskTx.finalize();
            }

            const txBytes = await tx.build({ client: suiClient });

            return mcpResponse({
                txBytes: Buffer.from(txBytes).toString('base64'),
                note: 'Sign and execute these tx bytes with your wallet',
            });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    server.tool('build_create_subname_tx',
    'Build a transaction to create a node subname (has its own NFT). Returns unsigned tx bytes.',
    {
        subname: z.string(),
        parentNftId: z.string(),
        expirationMs: z.number(),
        recipient: z.string(),
        allowChildCreation: z.boolean().default(true),
        allowTimeExtension: z.boolean().default(true),
        sender: z.string(),
    },
    async ({ subname, parentNftId, expirationMs, recipient, allowChildCreation, allowTimeExtension, sender }) => {
        try {
            const tx = new Transaction();
            tx.setSender(sender);
            const suinsTx = new SuinsTransaction(suinsClient, tx);

            const nft = suinsTx.createSubName({
                parentNft: parentNftId,
                name: subname,
                expirationTimestampMs: expirationMs,
                allowChildCreation,
                allowTimeExtension,
            });

            tx.transferObjects([nft], tx.pure.address(recipient));
            const txBytes = await tx.build({ client: suiClient });

            return mcpResponse({
                txBytes: Buffer.from(txBytes).toString('base64'),
                note: 'Sign and execute these tx bytes with your wallet',
            });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    server.tool('build_create_leaf_subname_tx',
    'Build a transaction to create a leaf subname (no NFT, controlled by parent). E.g. ossy.t2000.sui. Returns unsigned tx bytes.',
    {
        subname: z.string(),
        parentNftId: z.string(),
        targetAddress: z.string(),
        sender: z.string(),
        kioskId: z.string().optional(),
        kioskOwnerCapId: z.string().optional(),
    },
    async ({ subname, parentNftId, targetAddress, sender, kioskId, kioskOwnerCapId }) => {
        try {
            const tx = new Transaction();
            tx.setSender(sender);
            const suinsTx = new SuinsTransaction(suinsClient, tx);

            // Handle kiosk-owned NFTs
            let parentNftArg = parentNftId;
            let kioskTx;
            let borrowPromise;
            if (kioskId && kioskOwnerCapId) {
                kioskTx = new KioskTransaction({ transaction: tx, kioskClient: suiClient.kiosk });
                kioskTx.setKiosk(tx.object(kioskId)).setKioskCap(tx.object(kioskOwnerCapId));
                const [borrowedNft, promise] = kioskTx.borrow({ itemType: SUINS_NFT_TYPE, itemId: parentNftId });
                parentNftArg = borrowedNft;
                borrowPromise = promise;
            }

            suinsTx.createLeafSubName({
                parentNft: parentNftArg,
                name: subname,
                targetAddress,
            });

            // Return NFT to kiosk if borrowed
            if (kioskTx && borrowPromise) {
                kioskTx.return({ itemType: SUINS_NFT_TYPE, item: parentNftArg, promise: borrowPromise });
                kioskTx.finalize();
            }

            const txBytes = await tx.build({ client: suiClient });

            return mcpResponse({
                txBytes: Buffer.from(txBytes).toString('base64'),
                note: 'Sign and execute these tx bytes with your wallet',
            });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    server.tool('build_remove_leaf_subname_tx',
    'Build a transaction to remove a leaf subname. Returns unsigned tx bytes.',
    {
        subname: z.string(),
        parentNftId: z.string(),
        sender: z.string(),
        kioskId: z.string().optional(),
        kioskOwnerCapId: z.string().optional(),
    },
    async ({ subname, parentNftId, sender, kioskId, kioskOwnerCapId }) => {
        try {
            const tx = new Transaction();
            tx.setSender(sender);
            const suinsTx = new SuinsTransaction(suinsClient, tx);

            // Handle kiosk-owned NFTs
            let parentNftArg = parentNftId;
            let kioskTx;
            let borrowPromise;
            if (kioskId && kioskOwnerCapId) {
                kioskTx = new KioskTransaction({ transaction: tx, kioskClient: suiClient.kiosk });
                kioskTx.setKiosk(tx.object(kioskId)).setKioskCap(tx.object(kioskOwnerCapId));
                const [borrowedNft, promise] = kioskTx.borrow({ itemType: SUINS_NFT_TYPE, itemId: parentNftId });
                parentNftArg = borrowedNft;
                borrowPromise = promise;
            }

            suinsTx.removeLeafSubName({
                parentNft: parentNftArg,
                name: subname,
            });

            // Return NFT to kiosk if borrowed
            if (kioskTx && borrowPromise) {
                kioskTx.return({ itemType: SUINS_NFT_TYPE, item: parentNftArg, promise: borrowPromise });
                kioskTx.finalize();
            }

            const txBytes = await tx.build({ client: suiClient });

            return mcpResponse({
                txBytes: Buffer.from(txBytes).toString('base64'),
                note: 'Sign and execute these tx bytes with your wallet',
            });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    server.tool('build_set_target_address_tx',
    'Build a transaction to set the target address for a .sui name. Returns unsigned tx bytes.',
    {
        nftId: z.string(),
        address: z.string(),
        isSubname: z.boolean().default(false),
        sender: z.string(),
    },
    async ({ nftId, address, isSubname, sender }) => {
        try {
            const tx = new Transaction();
            tx.setSender(sender);
            const suinsTx = new SuinsTransaction(suinsClient, tx);

            suinsTx.setTargetAddress({
                nft: nftId,
                address,
                isSubname,
            });

            const txBytes = await tx.build({ client: suiClient });

            return mcpResponse({
                txBytes: Buffer.from(txBytes).toString('base64'),
                note: 'Sign and execute these tx bytes with your wallet',
            });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    server.tool('build_set_default_name_tx',
    'Build a transaction to set a .sui name as the default for the signer address. Returns unsigned tx bytes.',
    { name: z.string(), sender: z.string() },
    async ({ name, sender }) => {
        try {
            const tx = new Transaction();
            tx.setSender(sender);
            const suinsTx = new SuinsTransaction(suinsClient, tx);

            suinsTx.setDefault(name);

            const txBytes = await tx.build({ client: suiClient });

            return mcpResponse({
                txBytes: Buffer.from(txBytes).toString('base64'),
                note: 'Sign and execute these tx bytes with your wallet. Signer must be the target address of this name.',
            });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    server.tool('build_edit_subname_setup_tx',
    'Build a transaction to edit a subname setup (child creation / time extension). Returns unsigned tx bytes.',
    {
        name: z.string(),
        parentNftId: z.string(),
        allowChildCreation: z.boolean(),
        allowTimeExtension: z.boolean(),
        sender: z.string(),
    },
    async ({ name, parentNftId, allowChildCreation, allowTimeExtension, sender }) => {
        try {
            const tx = new Transaction();
            tx.setSender(sender);
            const suinsTx = new SuinsTransaction(suinsClient, tx);

            suinsTx.editSetup({
                name,
                parentNft: parentNftId,
                allowChildCreation,
                allowTimeExtension,
            });

            const txBytes = await tx.build({ client: suiClient });

            return mcpResponse({
                txBytes: Buffer.from(txBytes).toString('base64'),
                note: 'Sign and execute these tx bytes with your wallet',
            });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    server.tool('build_extend_expiration_tx',
    'Build a transaction to extend a subname expiration. Returns unsigned tx bytes.',
    {
        nftId: z.string(),
        expirationMs: z.number(),
        sender: z.string(),
        kioskId: z.string().optional(),
        kioskOwnerCapId: z.string().optional(),
    },
    async ({ nftId, expirationMs, sender, kioskId, kioskOwnerCapId }) => {
        try {
            const tx = new Transaction();
            tx.setSender(sender);
            const suinsTx = new SuinsTransaction(suinsClient, tx);

            // Handle kiosk-owned NFTs
            let nftArg = nftId;
            let kioskTx;
            let borrowPromise;
            if (kioskId && kioskOwnerCapId) {
                kioskTx = new KioskTransaction({ transaction: tx, kioskClient: suiClient.kiosk });
                kioskTx.setKiosk(tx.object(kioskId)).setKioskCap(tx.object(kioskOwnerCapId));
                const [borrowedNft, promise] = kioskTx.borrow({ itemType: SUINS_NFT_TYPE, itemId: nftId });
                nftArg = borrowedNft;
                borrowPromise = promise;
            }

            suinsTx.extendExpiration({
                nft: nftArg,
                expirationTimestampMs: expirationMs,
            });

            // Return NFT to kiosk if borrowed
            if (kioskTx && borrowPromise) {
                kioskTx.return({ itemType: SUINS_NFT_TYPE, item: nftArg, promise: borrowPromise });
                kioskTx.finalize();
            }

            const txBytes = await tx.build({ client: suiClient });

            return mcpResponse({
                txBytes: Buffer.from(txBytes).toString('base64'),
                note: 'Sign and execute these tx bytes with your wallet',
            });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    server.tool('build_set_metadata_tx',
    'Build a transaction to set metadata on a .sui name (avatar, content hash, walrus site ID). Returns unsigned tx bytes.',
    {
        nftId: z.string(),
        isSubname: z.boolean().default(false),
        avatar: z.string().optional(),
        contentHash: z.string().optional(),
        walrusSiteId: z.string().optional(),
        sender: z.string(),
        kioskId: z.string().optional(),
        kioskOwnerCapId: z.string().optional(),
    },
    async ({ nftId, isSubname, avatar, contentHash, walrusSiteId, sender, kioskId, kioskOwnerCapId }) => {
        try {
            const tx = new Transaction();
            tx.setSender(sender);
            const suinsTx = new SuinsTransaction(suinsClient, tx);

            // Handle kiosk-owned NFTs
            let nftArg = nftId;
            let kioskTx;
            let borrowPromise;
            if (kioskId && kioskOwnerCapId) {
                kioskTx = new KioskTransaction({ transaction: tx, kioskClient: suiClient.kiosk });
                kioskTx.setKiosk(tx.object(kioskId)).setKioskCap(tx.object(kioskOwnerCapId));
                const [borrowedNft, promise] = kioskTx.borrow({ itemType: SUINS_NFT_TYPE, itemId: nftId });
                nftArg = borrowedNft;
                borrowPromise = promise;
            }

            if (avatar) {
                suinsTx.setUserData({ nft: nftArg, key: ALLOWED_METADATA.avatar, value: avatar, isSubname });
            }
            if (contentHash) {
                suinsTx.setUserData({ nft: nftArg, key: ALLOWED_METADATA.contentHash, value: contentHash, isSubname });
            }
            if (walrusSiteId) {
                suinsTx.setUserData({ nft: nftArg, key: ALLOWED_METADATA.walrusSiteId, value: walrusSiteId, isSubname });
            }

            // Return NFT to kiosk if borrowed
            if (kioskTx && borrowPromise) {
                kioskTx.return({ itemType: SUINS_NFT_TYPE, item: nftArg, promise: borrowPromise });
                kioskTx.finalize();
            }

            const txBytes = await tx.build({ client: suiClient });

            return mcpResponse({
                txBytes: Buffer.from(txBytes).toString('base64'),
                note: 'Sign and execute these tx bytes with your wallet',
            });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    server.tool('build_burn_expired_tx',
    'Build a transaction to burn an expired .sui name and reclaim storage rebates. Returns unsigned tx bytes.',
    {
        nftId: z.string(),
        isSubname: z.boolean().default(false),
        sender: z.string(),
        kioskId: z.string().optional(),
        kioskOwnerCapId: z.string().optional(),
    },
    async ({ nftId, isSubname, sender, kioskId, kioskOwnerCapId }) => {
        try {
            const tx = new Transaction();
            tx.setSender(sender);
            const suinsTx = new SuinsTransaction(suinsClient, tx);

            // Handle kiosk-owned NFTs - use take() since burn consumes the NFT
            let nftArg = nftId;
            if (kioskId && kioskOwnerCapId) {
                const kioskTx = new KioskTransaction({ transaction: tx, kioskClient: suiClient.kiosk });
                kioskTx.setKiosk(tx.object(kioskId)).setKioskCap(tx.object(kioskOwnerCapId));
                nftArg = kioskTx.take({ itemType: SUINS_NFT_TYPE, itemId: nftId });
                kioskTx.finalize();
            }

            suinsTx.burnExpired({
                nft: nftArg,
                isSubname,
            });

            const txBytes = await tx.build({ client: suiClient });

            return mcpResponse({
                txBytes: Buffer.from(txBytes).toString('base64'),
                note: 'Sign and execute these tx bytes with your wallet',
            });
        } catch (e) { return mcpResponse({ error: e.message }); }
    });

    return server;
}

function formatPrices(priceList) {
    // priceList is a Map with tuple keys like [minLen, maxLen]
    // Convert to object with string keys like "3,3", "4,4", "5,63"
    const map = Object.fromEntries(priceList);
    return {
        '3-letter': Number(map['3,3']) / 1_000_000,
        '4-letter': Number(map['4,4']) / 1_000_000,
        '5+-letter': Number(map['5,63']) / 1_000_000,
    };
}


function mcpResponse(data) {
    return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
    };
}

// TRANSPORT

// Map of sessionId -> transport for stateful multi-session support
const sessions = new Map();

const port = parseInt(process.env.PORT || '3000');

const httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', name: 'suins-mcp', version: '1.0.1' }));
        return;
    }

    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('suins-mcp running');
        return;
    }

    if (req.url?.startsWith('/mcp')) {
        try {
            console.log(`Incoming MCP ${req.method} request:`, req.url);
            const sessionId = req.headers['mcp-session-id'];

            let transport;

            if (sessionId && sessions.has(sessionId)) {
                transport = sessions.get(sessionId);
            } else if (!sessionId && req.method === 'POST') {
                // New session — create a fresh server + transport
                const server = createServer();
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => crypto.randomUUID(),
                    onsessioninitialized: (id) => {
                        sessions.set(id, transport);
                        // Clean up session when it closes
                        transport.onclose = () => sessions.delete(id);
                    },
                });
                await server.connect(transport);
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bad request: unknown session' }));
                return;
            }

            await transport.handleRequest(req, res);
        } catch (err) {
            console.error('MCP error:', err);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end('Internal Server Error');
            }
        }
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

httpServer.listen(port, '0.0.0.0', () => {
    console.log(`suins-mcp HTTP server running on port ${port}`);
});

httpServer.on('error', (err) => {
    console.error('Server error:', err);
});