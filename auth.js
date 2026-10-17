'use strict';
/**
 * Wayfire: вход через Microsoft и проверка лицензии Minecraft: Java Edition.
 * Node.js 18+, внешние пакеты не нужны. В Electron работает в главном процессе.
 *
 * Цепочка входа (так делают все сторонние лаунчеры):
 *   1. Microsoft: вход по коду (device code), пользователь вводит код на странице Microsoft
 *   2. Xbox Live: обмен токена Microsoft на токен Xbox
 *   3. XSTS: токен для сервисов Minecraft
 *   4. Minecraft Services: вход и получение игрового токена
 *   5. Лицензия: у аккаунта должен быть профиль Minecraft Java Edition
 */

const MS_BASE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE = 'XboxLive.signin offline_access';

const XERR = {
  2148916233: 'У этой учётной записи Microsoft нет профиля Xbox. Создай его на xbox.com и попробуй снова.',
  2148916235: 'Xbox Live недоступен в твоей стране или регионе.',
  2148916236: 'Для этой учётной записи нужна проверка возраста на xbox.com.',
  2148916237: 'Для этой учётной записи нужна проверка возраста на xbox.com.',
  2148916238: 'Это детская учётная запись: её нужно добавить в семейную группу Microsoft.'
};

class AuthError extends Error {
  constructor(step, message, code) {
    super(message);
    this.name = 'AuthError';
    this.step = step;
    this.code = code;
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new AuthError('microsoft', 'Вход отменён', 'cancelled')); }, { once: true });
});

/**
 * @param {object}   opts
 * @param {string}   opts.clientId    Application (client) ID из Azure
 * @param {object}  [opts.store]      { load(), save(obj), clear() }: хранилище токена обновления
 * @param {function}[opts.onProgress] ({step,status,message}) шаги: microsoft, xbox, xsts, minecraft, license
 * @param {function}[opts.fetch]      подмена fetch (для тестов)
 */
function createAuth(opts) {
  const clientId = opts && opts.clientId;
  if (!clientId || /ВСТАВЬ/.test(clientId)) throw new Error('Не указан clientId приложения Azure (см. README)');
  const f = opts.fetch || globalThis.fetch;
  const store = opts.store || { load: async () => null, save: async () => {}, clear: async () => {} };
  const emit = opts.onProgress || (() => {});
  let abort = null;

  async function req(url, { method = 'GET', json, form, headers = {} } = {}, step = 'network') {
    const h = { Accept: 'application/json', ...headers };
    let body;
    if (json) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    else if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    let res;
    try {
      res = await f(url, { method, headers: h, body, signal: abort && abort.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new AuthError(step, 'Вход отменён', 'cancelled');
      throw new AuthError(step, 'Нет связи с сервером. Проверь интернет.', 'network');
    }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { /* не JSON */ }
    return { status: res.status, ok: res.ok, data };
  }

  async function poll(d) {
    const until = Date.now() + (d.expires_in || 900) * 1000;
    let wait = (d.interval != null ? d.interval : 5) * 1000;
    while (Date.now() < until) {
      await sleep(wait, abort && abort.signal);
      const r = await req(MS_BASE + '/token', {
        method: 'POST',
        form: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: d.device_code }
      }, 'microsoft');
      if (r.ok) return r.data;
      const err = r.data.error;
      if (err === 'authorization_pending') continue;
      if (err === 'slow_down') { wait += 5000; continue; }
      if (err === 'authorization_declined') throw new AuthError('microsoft', 'Вход отклонён на странице Microsoft.', err);
      if (err === 'expired_token') throw new AuthError('microsoft', 'Код истёк. Начни вход заново.', err);
      throw new AuthError('microsoft', r.data.error_description || 'Не удалось войти в Microsoft.', err || 'token');
    }
    throw new AuthError('microsoft', 'Код истёк. Начни вход заново.', 'expired_token');
  }

  async function finish(tokens) {
    emit({ step: 'microsoft', status: 'done' });

    // Xbox Live
    emit({ step: 'xbox', status: 'active' });
    const xbl = await req('https://user.auth.xboxlive.com/user/authenticate', {
      method: 'POST',
      json: {
        Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + tokens.access_token },
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT'
      }
    }, 'xbox');
    if (!xbl.ok) throw new AuthError('xbox', 'Не удалось войти в Xbox Live.', 'xbl');

    // XSTS
    const xsts = await req('https://xsts.auth.xboxlive.com/xsts/authorize', {
      method: 'POST',
      json: {
        Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.data.Token] },
        RelyingParty: 'rp://api.minecraftservices.com/',
        TokenType: 'JWT'
      }
    }, 'xbox');
    if (!xsts.ok) {
      const code = xsts.data.XErr;
      throw new AuthError('xbox', XERR[code] || 'Xbox отклонил вход (код ' + (code || xsts.status) + ').', 'xsts_' + code);
    }
    emit({ step: 'xbox', status: 'done' });

    // Minecraft Services
    emit({ step: 'minecraft', status: 'active' });
    const uhs = xsts.data.DisplayClaims.xui[0].uhs;
    const mc = await req('https://api.minecraftservices.com/authentication/login_with_xbox', {
      method: 'POST',
      json: { identityToken: 'XBL3.0 x=' + uhs + ';' + xsts.data.Token }
    }, 'minecraft');
    if (mc.status === 403) {
      throw new AuthError('minecraft', 'Mojang ещё не одобрил это приложение для входа (см. README, шаг 3).', 'app_not_approved');
    }
    if (!mc.ok) throw new AuthError('minecraft', 'Не удалось войти в сервисы Minecraft.', 'mc_login');
    emit({ step: 'minecraft', status: 'done' });

    // Лицензия: профиль Minecraft Java Edition
    emit({ step: 'license', status: 'active' });
    const auth = { Authorization: 'Bearer ' + mc.data.access_token };
    const ent = await req('https://api.minecraftservices.com/entitlements/mcstore', { headers: auth }, 'license');
    const items = (ent.data.items || []).map(i => i.name);
    const owns = items.includes('game_minecraft') || items.includes('product_minecraft');
    const prof = await req('https://api.minecraftservices.com/minecraft/profile', { headers: auth }, 'license');

    if (tokens.refresh_token) await store.save({ refreshToken: tokens.refresh_token });

    if (prof.status === 404 || !prof.data.id) {
      emit({ step: 'license', status: 'error', message: 'На аккаунте нет Minecraft: Java Edition.' });
      return { ok: true, licensed: false, owns, name: '', uuid: '' };
    }
    if (!prof.ok) throw new AuthError('license', 'Не удалось получить профиль Minecraft.', 'profile');

    let skinData = null;
    let slim = false;
    try {
      const sk = (prof.data.skins || []).find(s => s.state === 'ACTIVE');
      if (sk) {
        const r = await f(sk.url, { signal: abort && abort.signal });
        const buf = Buffer.from(await r.arrayBuffer());
        skinData = 'data:image/png;base64,' + buf.toString('base64');
        slim = sk.variant === 'SLIM';
      }
    } catch (e) { /* скин не обязателен */ }

    emit({ step: 'license', status: 'done' });
    // mcToken нужен только главному процессу для запуска игры, в окно лаунчера он не передаётся
    return { ok: true, licensed: true, owns, name: prof.data.name, uuid: prof.data.id, skinData, slim, mcToken: mc.data.access_token };
  }

  function failResult(e) {
    const err = e instanceof AuthError ? e : new AuthError('network', (e && e.message) || 'Неизвестная ошибка', 'unknown');
    emit({ step: err.step, status: 'error', message: err.message });
    return { ok: false, error: err.message, step: err.step, code: err.code };
  }

  /** Начать вход. Возвращает код для пользователя сразу, а итог входа придёт в done. */
  async function start() {
    abort = new AbortController();
    const r = await req(MS_BASE + '/devicecode', { method: 'POST', form: { client_id: clientId, scope: SCOPE } }, 'microsoft');
    if (!r.ok) throw new AuthError('microsoft', r.data.error_description || 'Не удалось получить код входа.', 'devicecode');
    const d = r.data;
    emit({ step: 'microsoft', status: 'active', message: 'Ждём подтверждения на странице Microsoft' });
    const done = poll(d).then(finish).catch(failResult);
    return { code: { userCode: d.user_code, verificationUri: d.verification_uri, expiresIn: d.expires_in }, done };
  }

  /** Тихий вход по сохранённому токену при запуске лаунчера. */
  async function restore() {
    const saved = await store.load();
    if (!saved || !saved.refreshToken) return null;
    abort = new AbortController();
    const r = await req(MS_BASE + '/token', {
      method: 'POST',
      form: { client_id: clientId, grant_type: 'refresh_token', refresh_token: saved.refreshToken, scope: SCOPE }
    }, 'microsoft');
    if (!r.ok) { await store.clear(); return null; }
    return finish(r.data).catch(failResult);
  }

  return {
    start,
    restore,
    cancel: () => { if (abort) abort.abort(); },
    signOut: () => store.clear()
  };
}

module.exports = { createAuth, AuthError };
