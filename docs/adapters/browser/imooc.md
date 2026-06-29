# 慕课网手记 (imooc)

**Mode**: 🍪 Browser session · **Domain**: www.imooc.com

Publish 手记 articles to 慕课网 using your logged-in browser session. Markdown body; external images are rehosted. Always saved as a draft.

## Commands

| Command | Description |
|---------|-------------|
| `opencli imooc login` | Open a browser to sign in |
| `opencli imooc whoami` | Show the signed-in account |
| `opencli imooc article` | Publish a 手记 (draft) |

## Usage Examples

```bash
opencli imooc login
opencli imooc whoami -f json

opencli imooc article --title "标题" --file ./post.md -f json
```
