# 人人都是产品经理 (woshipm)

**Mode**: 🍪 Browser session · **Domain**: woshipm.com

Publish articles to [人人都是产品经理](https://www.woshipm.com) using your logged-in browser session. The platform is review-gated: a submitted article enters a `pending` queue and is published only after manual review.

## Commands

| Command | Description |
|---------|-------------|
| `opencli woshipm login` | Open a browser to sign in |
| `opencli woshipm whoami` | Show the signed-in account |
| `opencli woshipm article --title <t> ...` | Publish an article (Markdown body; images are rehosted) |

## Usage Examples

```bash
opencli woshipm login
opencli woshipm whoami -f json

# Submit for review (default), or keep a draft with --draft
opencli woshipm article --title "标题" --file ./post.md -f json
opencli woshipm article --title "标题" --file ./post.md --draft -f json
```

> Submitted articles are `pending` until an editor approves them (typically within 24h).
