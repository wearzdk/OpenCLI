# 开源中国 (oschina)

**Mode**: 🍪 Browser session · **Domain**: my.oschina.net

Publish blog posts to 开源中国 using your logged-in browser session. Markdown body; external images are rehosted. Default publishes live; `--draft` saves a draft.

## Commands

| Command | Description |
|---------|-------------|
| `opencli oschina login` | Open a browser to sign in |
| `opencli oschina whoami` | Show the signed-in account |
| `opencli oschina catalogs` | List your blog catalogs |
| `opencli oschina article` | Publish a blog post |

## Usage Examples

```bash
opencli oschina login
opencli oschina whoami -f json

opencli oschina article --title "标题" --file ./post.md -f json
```
