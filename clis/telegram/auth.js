import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerTokenAuth, requireCredentials } from '../_shared/token-auth.js';

// Telegram 频道发布：Bot API（@BotFather 建 bot 拿 token，把 bot 设为目标频道管理员）。
// 凭证：bot token + 频道 id（@channelusername 或 -100xxxxxxxxxx 数字 id）。
// 这是「发频道」路径；发「真人号」需 MTProto（Telethon），是另一条线，本适配器不做。

const API = 'https://api.telegram.org';

/** 调一个 Bot API 方法（GET 查询或 multipart/json body）。401/404(token) → AuthRequiredError。 */
export async function botCall(token, method, init) {
  let res;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, init);
  } catch (err) {
    throw new CommandExecutionError(`Telegram request failed (${method}): ${err?.message ?? err}`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || (res.status === 404 && !body?.ok)) {
    throw new AuthRequiredError('telegram', `Telegram bot token rejected (HTTP ${res.status}) on ${method}`);
  }
  return { res, body };
}

/** 已配置凭证 {token, chat}。 */
export function telegramCreds() {
  const creds = requireCredentials('telegram');
  return { token: creds.token, chat: creds.chat };
}

registerTokenAuth({
  site: 'telegram',
  domain: 'telegram.org',
  fields: [
    { name: 'token', required: true, help: 'Bot token from @BotFather' },
    { name: 'chat', required: true, help: 'Channel id: @channelusername or -100xxxxxxxxxx (bot must be an admin)' },
  ],
  identityColumns: ['id', 'username', 'name', 'chat'],
  loginDescription: 'Configure a Telegram bot token + target channel id (no browser).',
  validate: async (creds) => {
    const { res, body } = await botCall(creds.token, 'getMe');
    if (!res.ok || !body?.ok || !body?.result?.id) {
      throw new AuthRequiredError('telegram', `Telegram getMe failed (HTTP ${res.status}): ${body?.description ?? 'invalid bot token'}`);
    }
    const me = body.result;
    return { id: String(me.id), username: me.username ?? '', name: me.first_name ?? '', chat: creds.chat };
  },
});
