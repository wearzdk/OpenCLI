# CSDN

**Mode**: 🍪 Browser session · **Domain**: editor.csdn.net

Publish blog posts to CSDN using your logged-in browser session. Markdown body; images are rehosted. Columns can be listed with `csdn columns`.

## Commands

| Command | Description |
|---------|-------------|
| `opencli csdn login` | Open a browser to sign in |
| `opencli csdn whoami` | Show the signed-in account |
| `opencli csdn columns` | List your columns/专栏 |
| `opencli csdn article` | Publish a blog post |

## Usage Examples

```bash
opencli csdn login
opencli csdn whoami -f json

opencli csdn article --title "标题" --file ./post.md -f json
```
