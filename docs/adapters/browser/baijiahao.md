# 百家号

**Mode**: 🍪 Browser session · **Domain**: baijiahao.baidu.com

Publish articles to 百度百家号 using your logged-in browser session. Markdown body; images are rehosted to the platform. Live publishing requires a cover (`--cover`); `--draft` saves a draft (no cover needed).

## Commands

| Command | Description |
|---------|-------------|
| `opencli baijiahao login` | Open a browser to sign in |
| `opencli baijiahao whoami` | Show the signed-in account |
| `opencli baijiahao lists` | List your articles |
| `opencli baijiahao article` | Publish an article |

## Usage Examples

```bash
opencli baijiahao login
opencli baijiahao whoami -f json

opencli baijiahao article --title "标题" --file ./post.md -f json
```
