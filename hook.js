(config) => {
  const previous = window.__ymdLyricsHook;
  if (previous && previous.id === config.id) return;
  if (previous && typeof previous.retire === 'function') previous.retire();

  const original = window.fetch.bind(window);
  const tracks = new Map();
  const pending = new Map();
  const queue = [];
  let retired = false;
  let active = 0;
  let pausedUntil = 0;
  let saveTimer = null;

  const readStored = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(config.storageKey) || '[]');
      return Array.isArray(stored) ? stored : Object.entries(stored);
    } catch (error) {
      return [];
    }
  };
  const verdicts = new Map(readStored());

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      let texts = 0;
      const stored = [...verdicts]
        .reverse()
        .map(([id, [found, at, lrc]]) => [id, lrc && texts++ < config.storedTexts ? [found, at, lrc] : [found, at]])
        .reverse();
      try {
        localStorage.setItem(config.storageKey, JSON.stringify(stored));
      } catch (error) {
        return;
      }
    }, config.saveDelay);
  };

  const foundOf = (id) => {
    const verdict = verdicts.get(id);
    if (!verdict) return undefined;
    const ttl = verdict[0] ? config.foundTtl : config.missingTtl;
    return Date.now() - verdict[1] < ttl ? verdict[0] === 1 : undefined;
  };

  const remember = (id, lrc) => {
    verdicts.delete(id);
    if (verdicts.size >= config.verdictLimit) verdicts.delete(verdicts.keys().next().value);
    verdicts.set(id, [lrc ? 1 : 0, Date.now(), lrc]);
    save();
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const pump = () => {
    while (active < config.concurrency && queue.length) {
      const job = queue.shift();
      active++;
      job.task().then(job.resolve, job.reject).finally(() => {
        active--;
        pump();
      });
    }
  };

  const limited = (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });

  const search = async (params) => {
    const url = config.lrclib + 'search?' + new URLSearchParams(params);
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < config.retryDelays.length;
      if (pausedUntil > Date.now()) await wait(pausedUntil - Date.now());
      let response = null;
      try {
        response = await original(url, { signal: AbortSignal.timeout(config.requestTimeout) });
      } catch (error) {
        if (error.name === 'TimeoutError' || !canRetry) throw error;
        await wait(config.retryDelays[attempt]);
        continue;
      }
      if (response.ok) return response.json();
      if (response.status === 404) return [];
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        pausedUntil = Date.now() + (seconds > 0 ? seconds * 1000 : config.rateLimitPause);
      }
      if ((response.status !== 429 && response.status < 500) || !canRetry) throw new Error('LRCLIB ' + response.status);
      await wait(config.retryDelays[attempt]);
    }
  };

  const findLrc = async (track) => {
    const results = await search({ track_name: track.title, artist_name: track.artist });
    const best = results
      .filter((item) => item.syncedLyrics && Math.abs((item.duration || 0) - track.duration) <= config.maxDurationDiff)
      .sort((a, b) => Math.abs(a.duration - track.duration) - Math.abs(b.duration - track.duration))[0];
    return best ? best.syncedLyrics : null;
  };

  const lookup = (id) => {
    if (pending.has(id)) return pending.get(id);
    const track = tracks.get(id);
    const job = limited(() => findLrc(track))
      .then((lrc) => {
        remember(id, lrc);
        return Boolean(lrc);
      })
      .catch((error) => {
        console.warn(config.logPrefix + track.title + ': ' + ((error && error.message) || error));
        return undefined;
      })
      .finally(() => pending.delete(id));
    pending.set(id, job);
    return job;
  };

  const hasText = (id) => {
    if (!tracks.has(id)) return Promise.resolve(false);
    const found = foundOf(id);
    return found === undefined ? lookup(id) : Promise.resolve(found);
  };

  const textFor = async (id) => {
    const cached = verdicts.get(id);
    if (cached && cached[2]) return cached[2];
    if (!tracks.has(id)) return null;
    await lookup(id);
    return (verdicts.get(id) || [])[2] || null;
  };

  const artistOf = (node) => (node.artists[0] && node.artists[0].name) || node.ugcArtistName || '';

  const isTrack = (node) => !Array.isArray(node)
    && (typeof node.id === 'string' || typeof node.id === 'number')
    && typeof node.title === 'string'
    && Array.isArray(node.artists)
    && typeof node.durationMs === 'number'
    && (!node.type || node.type === 'music');

  const collectTracks = (node, found) => {
    if (!node || typeof node !== 'object') return found;
    if (isTrack(node) && artistOf(node)) found.push(node);
    for (const key of Object.keys(node)) collectTracks(node[key], found);
    return found;
  };

  const register = (node) => {
    const id = String(node.id);
    if (!tracks.has(id)) {
      if (tracks.size >= config.trackLimit) tracks.delete(tracks.keys().next().value);
      tracks.set(id, { title: node.title, artist: artistOf(node), duration: node.durationMs / 1000, ours: false });
    }
    return id;
  };

  const hasOwnSync = (node) => Boolean(node.lyricsInfo && node.lyricsInfo.hasAvailableSyncLyrics);

  const enable = (node, id) => {
    node.lyricsInfo = Object.assign({}, node.lyricsInfo, { hasAvailableSyncLyrics: true, hasAvailableTextLyrics: true });
    node.lyricsAvailable = true;
    tracks.get(id).ours = true;
  };

  const decorate = (data) => {
    let changed = false;
    for (const node of collectTracks(data, [])) {
      const id = register(node);
      if (hasOwnSync(node)) continue;
      const found = foundOf(id);
      if (found === undefined) hasText(id);
      if (found === false) continue;
      enable(node, id);
      changed = true;
    }
    return changed;
  };

  const jsonResponse = (data, response) => {
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('Content-Type', 'application/json');
    return new Response(JSON.stringify(data), { status: 200, headers });
  };

  const lyricsIdOf = (path) => {
    const raw = decodeURIComponent(path.split('/tracks/')[1].split('/')[0]);
    return tracks.has(raw) ? raw : raw.split(':')[0];
  };

  const lyricsResponse = async (id, response) => {
    const ours = Boolean(tracks.get(id) && tracks.get(id).ours);
    if (!ours && !(window.__ymdReplace && (await hasText(id)))) return response;
    const lrc = await textFor(id);
    if (!lrc) return response;
    const yandex = response.ok ? await response.clone().json().catch(() => ({})) : {};
    const base = { lyricId: 0, externalLyricId: '0', writers: [], major: { id: 0, name: '', prettyName: '' } };
    return jsonResponse({ ...base, ...yandex, downloadUrl: config.override + '?id=' + encodeURIComponent(id) }, response);
  };

  const adjust = async (path, response) => {
    if (path.includes('/tracks/') && path.endsWith('/lyrics')) return lyricsResponse(lyricsIdOf(path), response);
    if (!response.ok || !(response.headers.get('content-type') || '').includes('json')) return response;
    const text = await response.clone().text();
    if (!text.includes('"durationMs"')) return response;
    const data = JSON.parse(text);
    return decorate(data) ? jsonResponse(data, response) : response;
  };

  window.fetch = async (input, init) => {
    if (retired) return original(input, init);
    const url = String((input && input.url) || input);
    if (url.startsWith(config.override)) {
      const lrc = await textFor(new URL(url).searchParams.get('id'));
      return new Response(lrc || '', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    const response = await original(input, init);
    if (!window.__ymdLyricsEnabled || !url.startsWith(config.api)) return response;
    try {
      return await adjust(url.split('?')[0], response);
    } catch (error) {
      console.warn(config.logPrefix + 'hook: ' + ((error && error.message) || error));
      return response;
    }
  };

  window.__ymdLyricsHook = { id: config.id, retire: () => { retired = true; } };
}
