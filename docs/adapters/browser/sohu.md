# 搜狐号 (sohu)

**Mode**: 🍪 Browser session · **Domain**: mp.sohu.com

Publish articles to 搜狐号 using your logged-in browser session. HTML body; external images are rehosted. A channel is required — list valid values with `sohu channels`. Default publishes live; `--draft` saves a draft.

## Commands

| Command | Description |
|---------|-------------|
| `opencli sohu login` | Open a browser to sign in |
| `opencli sohu whoami` | Show the signed-in account |
| `opencli sohu channels` | List valid channels |
| `opencli sohu categories` | List categories |
| `opencli sohu article` | Publish an article |

## Usage Examples

```bash
opencli sohu login
opencli sohu whoami -f json

opencli sohu article --title "标题" --file ./post.md -f json
```
