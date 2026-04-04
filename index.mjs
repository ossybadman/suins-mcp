#!/usr/bin/env node
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { SuinsClient, SuinsTransaction, ALLOWED_METADATA } from '@mysten/suins';
import { Transaction } from '@mysten/sui/transactions';

const suiClient = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('mainnet') });
const suinsClient = new SuinsClient({ client: suiClient, network: 'mainnet' });

function createServer() {
    const server = new McpServer({ name: 'suins-mcp', version: '1.0.0' });

    // ─── QUERY TOOLS ────────────────────────────────────────────────────────

    server.tool('resolve_name',
    'Resolve a .sui name to a wallet address',
    { name: z.string().describe('The .sui name to resolve e.g. ossy.sui') },
    async ({ name }) => {
        try {
            const address = await suiClient.resolveNameServiceAddress({ name });
            if (!address) return res({ error: `Name "${name}" not found or has no address` });
            return res({ name, address });
        } catch (e) { return res({ error: e.message }); }
    });

    server.tool('reverse_lookup',
    'Find the .sui name(s) for a wallet address',
    { address: z.string().describe('The Sui wallet address to look up') },
    async ({ address }) => {
        try {
            const result = await suiClient.resolveNameServiceNames({ address });
            if (!result?.data?.length) return res({ error: `No .sui name found for "${address}"` });
            return res({ address, names: result.data });
        } catch (e) { return res({ error: e.message }); }
    });

    server.tool('get_name_record',
    'Get full details of a .sui name including expiry, avatar, and content hash',
    { name: z.string().describe('The .sui name to get details for') },
    async ({ name }) => {
        try {
            const record = await suinsClient.getNameRecord(name);
            if (!record) return res({ error: `Name "${name}" not found` });
            return res({
                name: record.name,
                address: record.targetAddress,
                expiration: record.expirationTimestampMs,
                avatar: record.avatar,
                contentHash: record.contentHash,
                walrusSiteId: record.walrusSiteId,
            });
        } catch (e) { return res({ error: e.message }); }
    });

    server.tool('check_availability',
    'Check if a .sui name is available to register',
    { name: z.string().describe('The .sui name to check e.g. myname.sui') },
    async ({ name }) => {
        try {
            const record = await suinsClient.getNameRecord(name);
            return res({ name, available: !record });
        } catch (e) {
            return res({ name, available: true });
        }
    });

    server.tool('get_pricing',
    'Get current SuiNS registration pricing by name length',
    {},
    async () => {
        try {
            const priceList = await suinsClient.getPriceList();
            return res({ prices: Object.fromEntries(priceList), note: 'Prices are in USDC MIST. 1 USDC = 1,000,000 MIST' });
        } catch (e) { return res({ error: e.message }); }
    });

    server.tool('get_renewal_pricing',
    'Get current SuiNS renewal pricing by name length',
    {},
    async () => {
        try {
            const priceList = await suinsClient.getRenewalPriceList();
            return res({ prices: Object.fromEntries(priceList), note: 'Prices are in USDC MIST. 1 USDC = 1,000,000 MIST' });
        } catch (e) { return res({ error: e.message }); }
    });

    // ─── TRANSACTION TOOLS ──────────────────────────────────────────────────

    server.tool('build_register_tx',
    'Build a transaction to register a new .sui name. Returns unsigned tx bytes to be signed and executed by the caller.',
    {
        name: z.string().describe('The .sui name to register e.g. myname.sui'),
        years: z.number().min(1).max(5).describe('Number of years to register (1-5)'),
        coin: z.string().describe('Object ID of the coin to pay with'),
        coinType: z.enum(['USDC', 'SUI', 'NS']).describe('Coin type to pay with'),
        recipient: z.string().describe('Address to receive the name NFT'),
    },
    async ({ name, years, coin, coinType, recipient }) => {
        try {
            const tx = new Transaction();
            const suinsTx = new SuinsTransaction(suinsClient, tx);
            const coinConfig = suinsClient.config.coins[coinType];
            let priceInfoObjectId;
            if (coinType !== 'USDC') priceInfoObjectId = (await suinsClient.getPriceInfoObject(tx, coinConfig.feed))[0];
            const nft = suinsTx.register({ domain: name, years, coinConfig, coin, ...(priceInfoObjectId && { priceInfoObjectId }) });
            tx.transferObjects([nft], tx.pure.address(recipient));
            const txBytes = await tx.build({ client: suiClient });
            return res({ txBytes: Buffer.from(txBytes).toString('base64'), note: 'Sign and execute these tx bytes with your wallet' });
        } catch (e) { return res({ error: e.message }); }
    });

    server.tool('build_renew_tx',
    'Build a transaction to renew an existing .sui name. Returns unsigned tx bytes.',
    {
        name: z.string().describe('The .sui name to renew'),
        nftId: z.string().describe('Object ID of the SuiNS NFT'),
        years: z.number().min(1).max(5).describe('Number of years to renew (1-5)'),
        coin: z.string().describe('Object ID of the coin to pay with'),
        coinType: z.enum(['USDC', 'SUI', 'NS']).describe('Coin type to pay with'),
    },
    async ({ name, nftId, years, coin, coinType }) => {
        try {
            const tx = new Transaction();
            const suinsTx = new SuinsTransaction(suinsClient, tx);
            const coinConfig = suinsClient.config.coins[coinType];
            let priceInfoObjectId;
            if (coinType !== 'USDC') priceInfoObjectId = (await suinsClient.getPriceInfoObject(tx, coinConfig.feed))[0];
            suinsTx.renew({ nft: nftId, years, coinConfig, coin, ...(priceInfoObjectId && { priceInfoObjectId }) });
            const txBytes = await tx.build({ client: suiClient });
            return res({ txBytes: Buffer.from(txBytes).toString('base64'), note: 'Sign and execute these tx bytes with your wallet' });
        } catch (e) { return res({ error: e.message }); }
    });

    server.tool('build_create_subname_tx',
    'Build a transaction to create a node subname (has its own NFT). Returns unsigned tx bytes.',
    {
        subname: z.string().describe('Full subname to create e.g. sub.parent.sui'),
        parentNftId: z.string().describe('Object ID of the parent name NFT'),
        expirationMs: z.number().describe('Expiration timestamp in ms (must be <= parent expiration)'),
        recipient: z.string().describe('Address to receive the subname NFT'),
        allowChildCreation: z.boolean().default(true).describe('Whether this subname can create nested subnames'),
        allowTimeExtension: z.boolean().default(true).describe('Whether this subname can extend its expiration'),
    },
    async ({ subname, parentNftId, expirationMs, recipient, allowChildCreation, allowTimeExtension }) => {
        try {
            const tx = new Transaction();
            const suinsTx = new SuinsTransaction(suinsClient, tx);
            const nft = suinsTx.createSubName({ parentNft: parentNftId, name: subname, expirationTimestampMs: expirationMs, allowChildCreation, allowTimeExtension });
            tx.transferObjects([nft], tx.pure.address(recipient));
            const txBytes = await tx.build({ client: suiClient });
            return res({ txBytes: Buffer.from(txBytes).toString('base64'), note: 'Sign and execute these tx bytes with your wallet' });
        } catch (e) { return res({ error: e.message }); }
    });

    server.tool('build_create_leaf_subname_tx',
    'Build a transaction to create a leaf subname (no NFT, controlled by parent). E.g. ossy.t2000.sui. Returns unsigned tx bytes.',
    {
        subname: z.string().describe('Full leaf subname to create e.g. ossy.t2000.sui'),
        parentNftId: z.string().describe('Object ID of the parent name NFT'),
        targetAddress: z.string().describe('Wallet address this leaf subname should point to'),
    },
    async ({ subname, parentNftId, targetAddress }) => {
        try {
            const tx = new Transaction();
            const suinsTx = new SuinsTransaction(suinsClient, tx);
            suinsTx.createLeafSubName({ parentNft: parentNftId, name: subname, targetAddress });
            const txBytes = await tx.build({ client: suiClient });
            return res({ txBytes: Buffer.from(txBytes).toString('base64'), note: 'Sign and execute these tx bytes with your wallet' });
        } catch (e) { return res({ error: e.message }); }
    });

    server.tool('build_remove_leaf_subname_tx',
    'Build a transaction to remove a leaf subname. Returns unsigned tx bytes.',
    {
        subname: z.string().describe('Full leaf subname to remove e.g. ossy.t2000.sui'),
        parentNftId: z.string().describe('Object ID of the parent name NFT'),
    },
    async ({ subname, parentNftId }) => {
        try {
            const tx = new Transaction();
            const suinsTx = new SuinsTransaction(suinsClient, tx);
            suinsTx.removeLeafSubName({ parentNft: parentNftId, name: subname });
            const txBytes = await tx.build({ client: suiClient });
            return res({ txBytes: Buffer.from(txBytes).toString('base64'), note: 'Sign and execute these tx bytes with your wallet' });
        } catch (e) { return res({ error: e.message }); }
    });

    server.tool('build_set_target_address_tx',
    'Build a transaction to set the target address for a .sui name. Returns unsigned tx bytes.',
    {
        nftId: z.string().describe('Object ID of the SuiNS NFT'),
        address: z.string().describe('New target address'),
        isSubname: z.boolean().default(false).describe('Whether this is a subname'),
    },
    async ({ nftId, address, isSubname }) => {
        try {
            const tx = new Transaction();
            const suinsTx = new SuinsTransaction(suinsClient, tx);
            suinsTx.setTargetAddress({ nft: nftId, address, isSubname });
            const txBytes = await tx.build({ client: suiClient });
            return res({ txBytes: Buffer.from(txBytes).toString('base64'), note: 'Sign and execute these tx bytes with your wallet' });
        } catch (e) { return res({ error: e.message }); }
    });

    server.tool('build_set_default_name_tx',
    'Build a transaction to set a .sui name as the default for the signer address. Returns unsigned tx bytes.',
    { name: z.string().describe('The .sui name to set as default e.g. ossy.sui') },
    async ({ name }) => {
        try {
            const tx = new Transaction();
            const suinsTx = new SuinsTransaction(suinsClient, tx);
            suinsTx.setDefault(name);
            const txBytes = await tx.build({ client: suiClient });
            return res({ txBytes: Buffer.from(txBytes).toString('base64'), note: 'Sign and execute these tx bytes with your wallet. Signer must be the target address of this name.' });
        } catch (e) { return res({ error: e.message }); }
    });

    server.tool('build_edit_subname_setup_tx',
    'Build a transaction to edit a subname setup (child creation / time extension). Returns unsigned tx bytes.',
    {
        name: z.string().describe('The subname to edit'),
        parentNftId: z.string().describe('Object ID of the parent NFT'),
        allowChildCreation: z.boolean().describe('Whether to allow child subname creation'),
        allowTimeExtension: z.boolean().describe('Whether to allow time extension'),
    },
    async ({ name, parentNftId, allowChildCreation, allowTimeExtension }) => {
        try {
            const tx = new Transaction();
            const suinsTx = new SuinsTransaction(suinsClient, tx);
            suinsTx.editSetup({ name, parentNft: parentNftId, allowChildCreation, allowTimeExtension });
            const txBytes = await tx.build({ client: suiClient });
            return res({ txBytes: Buffer.from(txBytes).toString('base64'), note: 'Sign and execute these tx bytes with your wallet' });
        } catch (e) { return res({ error: e.message }); }
    });

    server.tool('build_extend_expiration_tx',
    'Build a transaction to extend a subname expiration. Returns unsigned tx bytes.',
    {
        nftId: z.string().describe('Object ID of the subname NFT'),
        expirationMs: z.number().describe('New expiration timestamp in milliseconds'),
    },
    async ({ nftId, expirationMs }) => {
        try {
            const tx = new Transaction();
            const suinsTx = new SuinsTransaction(suinsClient, tx);
            suinsTx.extendExpiration({ nft: nftId, expirationTimestampMs: expirationMs });
            const txBytes = await tx.build({ client: suiClient });
            return res({ txBytes: Buffer.from(txBytes).toString('base64'), note: 'Sign and execute these tx bytes with your wallet' });
        } catch (e) { return res({ error: e.message }); }
    });

    server.tool('build_set_metadata_tx',
    'Build a transaction to set metadata on a .sui name (avatar, content hash, walrus site ID). Returns unsigned tx bytes.',
    {
        nftId: z.string().describe('Object ID of the SuiNS NFT'),
        isSubname: z.boolean().default(false).describe('Whether this is a subname'),
        avatar: z.string().optional().describe('NFT object ID to use as avatar'),
        contentHash: z.string().optional().describe('IPFS content hash'),
        walrusSiteId: z.string().optional().describe('Walrus site ID'),
    },
    async ({ nftId, isSubname, avatar, contentHash, walrusSiteId }) => {
        try {
            const tx = new Transaction();
            const suinsTx = new SuinsTransaction(suinsClient, tx);
            if (avatar) suinsTx.setUserData({ nft: nftId, key: ALLOWED_METADATA.avatar, value: avatar, isSubname });
            if (contentHash) suinsTx.setUserData({ nft: nftId, key: ALLOWED_METADATA.contentHash, value: contentHash, isSubname });
            if (walrusSiteId) suinsTx.setUserData({ nft: nftId, key: ALLOWED_METADATA.walrusSiteId, value: walrusSiteId, isSubname });
            const txBytes = await tx.build({ client: suiClient });
            return res({ txBytes: Buffer.from(txBytes).toString('base64'), note: 'Sign and execute these tx bytes with your wallet' });
        } catch (e) { return res({ error: e.message }); }
    });

    server.tool('build_burn_expired_tx',
    'Build a transaction to burn an expired .sui name and reclaim storage rebates. Returns unsigned tx bytes.',
    {
        nftId: z.string().describe('Object ID of the expired SuiNS NFT'),
        isSubname: z.boolean().default(false).describe('Whether this is a subname'),
    },
    async ({ nftId, isSubname }) => {
        try {
            const tx = new Transaction();
            const suinsTx = new SuinsTransaction(suinsClient, tx);
            suinsTx.burnExpired({ nft: nftId, isSubname });
            const txBytes = await tx.build({ client: suiClient });
            return res({ txBytes: Buffer.from(txBytes).toString('base64'), note: 'Sign and execute these tx bytes with your wallet' });
        } catch (e) { return res({ error: e.message }); }
    });

    return server;
}

function res(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

// ─── TRANSPORT ──────────────────────────────────────────────────────────────

const server = createServer();
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

await server.connect(transport);

const port = parseInt(process.env.PORT || '3000');

const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', name: 'suins-mcp', version: '1.0.0' }));
        return;
    }

    if (req.url === '/mcp') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const parsed = body ? JSON.parse(body) : undefined;
                await transport.handleRequest(req, res, parsed);
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

httpServer.listen(port, '0.0.0.0', () => {
    console.log(`suins-mcp HTTP server running on port ${port}`);
});