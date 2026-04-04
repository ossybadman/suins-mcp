# suins-mcp

MCP server for Sui Name Service. Lets AI agents resolve `.sui` names, look up identities, and build SuiNS transactions.

---

## Integration

### Option A: Direct Integration (Remote MCP)

Use the MCP endpoint directly in any MCP-compatible client:

https://suins-mcp-production.up.railway.app/mcp

---

### Option B: Using Cursor

Add the server to your MCP configuration:

{
  "mcpServers": {
    "suins": {
      "transport": "http",
      "url": "https://suins-mcp-production.up.railway.app/mcp"
    }
  }
}

---

### Option C: Using Claude Code

Add the server via CLI:

claude mcp add --transport http suins https://suins-mcp-production.up.railway.app/mcp

---

## Tools

### Query tools

| Tool | Description |
|---|---|
| `resolve_name` | Resolve a `.sui` name to a wallet address |
| `reverse_lookup` | Find the `.sui` name(s) for a wallet address |
| `get_name_record` | Get full details (expiry, avatar, contentHash) of a name |
| `check_availability` | Check if a `.sui` name is available to register |
| `get_pricing` | Get current registration pricing by name length |
| `get_renewal_pricing` | Get current renewal pricing by name length |

---

### Transaction tools

These tools build unsigned Sui PTBs. The returned `txBytes` must be signed and executed by the caller's wallet.

| Tool | Description |
|---|---|
| `build_register_tx` | Register a new `.sui` name |
| `build_renew_tx` | Renew an existing `.sui` name |
| `build_create_subname_tx` | Create a node subname with its own NFT |
| `build_create_leaf_subname_tx` | Create a leaf subname e.g. `ossy.t2000.sui` |
| `build_remove_leaf_subname_tx` | Remove a leaf subname |
| `build_set_target_address_tx` | Point a name at a wallet address |
| `build_set_default_name_tx` | Set a name as default for the signer address |
| `build_edit_subname_setup_tx` | Toggle child creation / time extension on a subname |
| `build_extend_expiration_tx` | Extend a subname expiration |
| `build_set_metadata_tx` | Set avatar, content hash, or walrus site ID |
| `build_burn_expired_tx` | Burn expired name to reclaim storage rebates |
