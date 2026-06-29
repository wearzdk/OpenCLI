# 思否 (segmentfault)

**Mode**: 🍪 Browser session · **Domain**: segmentfault.com

Publish articles to 思否 (SegmentFault) using your logged-in browser session. Markdown body; external images are rehosted. Live publishing requires tags (`--tags`); validate tags with `segmentfault tags <name>` and list channels with `segmentfault channels`.

## Commands

| Command | Description |
|---------|-------------|
| `opencli segmentfault login` | Open a browser to sign in |
| `opencli segmentfault whoami` | Show the signed-in account |
| `opencli segmentfault tags` | Validate/look up tags |
| `opencli segmentfault channels` | List channels |
| `opencli segmentfault article` | Publish an article |

## Usage Examples

```bash
opencli segmentfault login
opencli segmentfault whoami -f json

opencli segmentfault article --title "标题" --file ./post.md -f json
```
