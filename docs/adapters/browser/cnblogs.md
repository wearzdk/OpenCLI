# 博客园 (cnblogs)

**Mode**: 🍪 Browser session · **Domain**: cnblogs.com

Publish blog posts to 博客园 using your logged-in browser session. Markdown body; images are rehosted.

## Commands

| Command | Description |
|---------|-------------|
| `opencli cnblogs login` | Open a browser to sign in |
| `opencli cnblogs whoami` | Show the signed-in account |
| `opencli cnblogs article` | Publish a blog post |

## Usage Examples

```bash
opencli cnblogs login
opencli cnblogs whoami -f json

opencli cnblogs article --title "标题" --file ./post.md -f json
```
