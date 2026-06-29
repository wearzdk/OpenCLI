# 语雀 (yuque)

**Mode**: 🍪 Browser session · **Domain**: yuque.com

Publish documents to [语雀](https://www.yuque.com) knowledge bases using your logged-in browser session. The body is Markdown by default and external images are rehosted to 语雀's image store.

## Commands

| Command | Description |
|---------|-------------|
| `opencli yuque login` | Open a browser to sign in |
| `opencli yuque whoami` | Show the signed-in account |
| `opencli yuque article <title> ...` | Publish a knowledge-base document (Markdown body) |

## Usage Examples

```bash
opencli yuque login
opencli yuque whoami -f json

opencli yuque article "标题" --file ./doc.md -f json
```
