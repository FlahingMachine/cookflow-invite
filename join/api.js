// The web guest's whole network layer: a guest session (Supabase anonymous sign-in) and the shared-list functions, over
// plain fetch. No library and no cookies. The anon key is the public one; it is never the service-role key.

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const SESSION_KEY = 'cookflow.guest.session.v1';

const safe = {
  get(storage, key) {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  },
  set(storage, key, value) {
    try {
      storage.setItem(key, value);
    } catch {
      // private mode or storage blocked: the guest session then lasts until the tab closes
    }
  },
  remove(storage, key) {
    try {
      storage.removeItem(key);
    } catch {
      // nothing to clean up
    }
  },
};

export class GuestApi {
  /**
   * @param {{url: string, anonKey: string}} config
   * @param {{fetch?: typeof fetch, storage?: Storage | null, now?: () => number}} [deps]
   */
  constructor(config, deps = {}) {
    this.url = String(config.url || '').replace(/\/+$/, '');
    this.anonKey = config.anonKey || '';
    this.fetch = deps.fetch || ((...a) => globalThis.fetch(...a));
    this.storage = deps.storage === undefined ? globalThis.localStorage : deps.storage;
    this.now = deps.now || Date.now;
    this.session = null;
    if (this.storage) {
      const raw = safe.get(this.storage, SESSION_KEY);
      if (raw) {
        try {
          this.session = JSON.parse(raw);
        } catch {
          this.session = null;
        }
      }
    }
  }

  get configured() {
    return this.url.startsWith('https://') && this.anonKey.length > 20;
  }

  async _request(path, { method = 'POST', body, auth = false } = {}) {
    const headers = { apikey: this.anonKey, 'content-type': 'application/json' };
    if (auth) headers.authorization = `Bearer ${this.session.access_token}`;
    let res;
    try {
      res = await this.fetch(`${this.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError('network', 'network', 0);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const message =
        (data && (data.message || data.msg || data.error_description || data.error)) ||
        `http ${res.status}`;
      throw new ApiError(String(message), data && (data.code || data.error_code), res.status);
    }
    return data;
  }

  _keep(data) {
    this.session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at
        ? data.expires_at * 1000
        : this.now() + (data.expires_in || 3600) * 1000,
    };
    if (this.storage) safe.set(this.storage, SESSION_KEY, JSON.stringify(this.session));
  }

  /** A signed-in guest: the stored session (refreshed when it is about to expire), else a new anonymous one. */
  async ensureSession() {
    if (this.session && this.session.expires_at - this.now() > 60_000) return this.session;
    if (this.session?.refresh_token) {
      try {
        this._keep(
          await this._request('/auth/v1/token?grant_type=refresh_token', {
            body: { refresh_token: this.session.refresh_token },
          }),
        );
        return this.session;
      } catch (e) {
        if (e.code === 'network') throw e;
        this.session = null;
        if (this.storage) safe.remove(this.storage, SESSION_KEY);
      }
    }
    this._keep(await this._request('/auth/v1/signup', { body: { data: {} } }));
    return this.session;
  }

  async rpc(fn, args = {}) {
    await this.ensureSession();
    try {
      return await this._request(`/rest/v1/rpc/${fn}`, { body: args, auth: true });
    } catch (e) {
      // a session the server no longer knows: start a fresh guest session once and ask again
      if (e.status === 401) {
        this.session = null;
        if (this.storage) safe.remove(this.storage, SESSION_KEY);
        await this.ensureSession();
        return this._request(`/rest/v1/rpc/${fn}`, { body: args, auth: true });
      }
      throw e;
    }
  }

  join(token) {
    return this.rpc('shared_list_join', { p_token: token });
  }
  load(listId) {
    return this.rpc('shared_list_load', { p_list: listId });
  }
  apply(listId, ops) {
    return this.rpc('shared_list_apply', { p_list: listId, p_ops: ops });
  }
  finish(listId, store, totalAgorot) {
    return this.rpc('shared_list_finish', {
      p_list: listId,
      p_store: store,
      p_total_agorot: totalAgorot,
    });
  }
  leave(listId) {
    return this.rpc('shared_list_leave', { p_list: listId });
  }
  signOut() {
    this.session = null;
    if (this.storage) safe.remove(this.storage, SESSION_KEY);
  }
}
