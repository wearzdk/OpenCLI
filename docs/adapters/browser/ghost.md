# Ghost

**Mode**: 🔑 Ghost Admin API · **Domain**: configured with `GHOST_ADMIN_URL`

Publish posts to a [Ghost](https://ghost.org) site through the Admin API, without driving a browser. Authentication uses a short-lived JWT signed from an Admin API key — handled for you by the adapter.

## Commands

| Command | Description |
|---------|-------------|
| `opencli ghost whoami` | Verify the connection (site title + version) |
| `opencli ghost publish --title <t> --content <body>` | Create a post (Markdown or HTML body) |

## Configuration

```bash
export GHOST_ADMIN_URL=https://your-site.com   # the site root (no trailing /ghost)
export GHOST_ADMIN_KEY=<id>:<hex-secret>       # the Admin API key
```

Create the key in Ghost at **Settings → Integrations → add custom integration**, then copy the **Admin API Key** (it has the form `id:secret`). Use the Admin API key, not the Content API key.

> The adapter signs a 5-minute HS256 JWT per request (the secret is hex-decoded before signing, as Ghost requires), so you never handle tokens yourself.

## Usage Examples

```bash
# Test the connection
opencli ghost whoami -f json

# Publish a draft from Markdown (default status is draft, for safety)
opencli ghost publish --title "Hello" --content "# Hi\n\nSome **bold** text." -f json

# Go live with tags (created if missing)
opencli ghost publish --title "Launch" --file ./post.md --status published --tags "news,product" -f json
```
