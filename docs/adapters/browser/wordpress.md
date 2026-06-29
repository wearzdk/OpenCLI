# WordPress

**Mode**: 🔑 WordPress REST API · **Domain**: configured with `WORDPRESS_BASE_URL`

Publish posts to a self-hosted WordPress site through the built-in REST API, without driving a browser. Authentication uses an [Application Password](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/) (WordPress 5.6+) over HTTP Basic auth — no OAuth app, no plugin.

## Commands

| Command | Description |
|---------|-------------|
| `opencli wordpress whoami` | Verify the connection (the authenticated user) |
| `opencli wordpress publish --title <t> --content <body>` | Create a post (Markdown or HTML body) |

## Configuration

```bash
export WORDPRESS_BASE_URL=https://your-site.com   # the site root
export WORDPRESS_USER=your-username
export WORDPRESS_APP_PASSWORD="abcd efgh ijkl mnop"   # spaces are optional
```

Create the Application Password in WordPress at **wp-admin → Users → Profile → Application Passwords**. It only works against the REST API and can be revoked independently of your login password.

> Some hosts or security plugins disable `/wp-json`. If `whoami` returns a 404, the REST API is likely turned off.

## Usage Examples

```bash
# Test the connection
opencli wordpress whoami -f json

# Publish a draft from Markdown (default status is draft, for safety)
opencli wordpress publish --title "Hello" --content "# Hi\n\nSome **bold** text." -f json

# Go live and set categories/tags by term ID
opencli wordpress publish --title "Launch" --file ./post.md --status publish --categories "3,5" --tags "9" -f json
```
