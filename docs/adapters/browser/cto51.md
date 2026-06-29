# 51CTO 博客 (cto51)

**Mode**: 🍪 Browser session · **Domain**: blog.51cto.com

Publish blog posts to 51CTO 博客 using your logged-in browser session. Markdown body; images are rehosted (Tencent COS). Saves as a draft.

## Commands

| Command | Description |
|---------|-------------|
| `opencli cto51 whoami` | Show the signed-in account |
| `opencli cto51 article` | Publish a blog post (draft) |

## Usage Examples

```bash
opencli cto51 login
opencli cto51 whoami -f json

opencli cto51 article --title "标题" --file ./post.md -f json
```
