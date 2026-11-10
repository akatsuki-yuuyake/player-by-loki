/*
 * Loki — плагин Lampa для своего аккаунта на сайте (адрес сайта указывается в настройках).
 * Кнопка «Loki» на карточке фильма → поиск → озвучка → сезон/серия → качество → плеер.
 * Логин/пароль хранятся только в Lampa.Storage на устройстве.
 * Код намеренно в ES5 (старые WebView на ТВ).
 */
(function () {
  'use strict';

  if (window.player_by_loki_loaded) return;
  window.player_by_loki_loaded = true;

  var PREFIX = 'player_by_loki_';

  var QUALITY_OPTIONS = { max: 'Максимальное', '2160': 'до 4K', '1080': 'до 1080p', '720': 'до 720p', '480': 'до 480p', ask: 'Спрашивать' };
  var QUALITY_SHORT = { max: 'максимальное', '2160': '4K', '1080': '1080p', '720': '720p', '480': '480p', ask: 'спрашивать' };

  // ---------- настройки ----------

  function cfg(name, def) {
    var v = Lampa.Storage.get(PREFIX + name, def === undefined ? '' : def);
    return typeof v === 'string' ? v.trim() : v;
  }

  /** адрес сайта из настроек; по умолчанию пусто — пользователь вписывает своё зеркало сам */
  function host() {
    var h = cfg('host');
    if (!h) return '';
    if (!/^https?:\/\//.test(h)) h = 'https://' + h;
    return h.replace(/\/+$/, '');
  }

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[player_by_loki]');
    try { console.log.apply(console, args); } catch (e) {}
  }

  function noty(text) { Lampa.Noty.show('Loki: ' + text); }

  // ---------- сеть ----------

  function encodeForm(obj) {
    var out = [];
    for (var k in obj) {
      if (obj.hasOwnProperty(k) && obj[k] !== undefined && obj[k] !== null) {
        out.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
      }
    }
    return out.join('&');
  }

  /**
   * Запрос к сайту. post — объект с полями формы или null для GET.
   * Используем network.native: в Android-версии Lampa он идёт нативно (без CORS).
   */

  function request(path, post, referer, onOk, onErr) {
    if (!host()) return onErr('укажите адрес сайта: Настройки → Loki → Зеркало');
    var url = /^https?:\/\//.test(path) ? path : host() + path;

    var net = new Lampa.Reguest();
    net.timeout(20000);

    var headers = {
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': referer || host() + '/',
      'Origin': host()
    };
    var cookie = mergeCookies(cfg('auto_cookie'));
    if (cookie) headers.Cookie = cookie;
    if (post) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';

    log('request', url, post ? encodeForm(post).replace(/login_password=[^&]*/, 'login_password=***') : '');

    net['native'](url, function (data) {
      // С returnHeaders Lampa отдаёт { body, headers } — забираем Set-Cookie сами,
      // потому что нативный слой приложения cookie между запросами не хранит.
      data = unwrapNative(data);
      if (typeof data !== 'string') {
        try { data = JSON.stringify(data); } catch (e) { data = String(data); }
      }
      onOk(data);
    }, function (a, c) {
      log('request error', url, a && a.status, c);
      onErr('сетевая ошибка' + (a && a.status ? ' (HTTP ' + a.status + ')' : ' — нужна официальная Lampa для Android'));
    }, post ? encodeForm(post) : false, { dataType: 'text', headers: headers, returnHeaders: true });
  }

  /**
   * Android-приложение при returnHeaders отдаёт обёртку (при dataType text — строкой JSON).
   * Разворачиваем её в тело страницы, по пути сохраняя Set-Cookie.
   */
  var wrapperReported = false;
  function unwrapNative(data) {
    var obj = data;
    if (typeof data === 'string' && /^\s*\{/.test(data) && /"(body|headers)"/.test(data.slice(0, 2000) + data.slice(-2000))) {
      try { obj = JSON.parse(data); } catch (e) { return data; }
    }
    if (!obj || typeof obj !== 'object') return data;
    var bodyKey = ['body', 'data', 'response', 'text'].filter(function (k) { return typeof obj[k] === 'string'; })[0];
    var headers = obj.headers || obj.header || obj.responseHeaders;
    if (!bodyKey && !headers) return data; // обычный JSON-ответ сайта
    if (headers) saveSetCookies(headers);
    if (bodyKey) return obj[bodyKey];
    if (!wrapperReported) {
      wrapperReported = true;
      noty('неизвестный формат ответа приложения, поля: ' + Object.keys(obj).join(', '));
    }
    log('native wrapper keys', Object.keys(obj));
    return data;
  }

  /** "a=1; b=2" + "b=3" → "a=1; b=3" (правые значения важнее). */
  function mergeCookies() {
    var map = {}, order = [];
    for (var i = 0; i < arguments.length; i++) {
      String(arguments[i] || '').split(';').forEach(function (part) {
        var eq = part.indexOf('=');
        if (eq < 1) return;
        var k = part.slice(0, eq).trim(), v = part.slice(eq + 1).trim();
        if (!k) return;
        if (!(k in map)) order.push(k);
        map[k] = v;
      });
    }
    return order.filter(function (k) { return map[k] !== '' && map[k] !== 'deleted'; })
      .map(function (k) { return k + '=' + map[k]; }).join('; ');
  }

  /** Достаёт Set-Cookie из заголовков ответа и дописывает в player_by_loki_auto_cookie. */
  function saveSetCookies(headers) {
    if (!headers || (typeof headers !== 'object' && typeof headers !== 'string')) return;
    var raw = [];
    if (typeof headers === 'string') {
      headers.split(/\r?\n/).forEach(function (l) { var m = l.match(/^set-cookie:\s*(.+)$/i); if (m) raw.push(m[1]); });
    } else {
      for (var k in headers) {
        if (headers.hasOwnProperty(k) && k.toLowerCase() === 'set-cookie') raw = raw.concat(headers[k]);
      }
    }
    var pairs = [];
    raw.forEach(function (line) {
      // несколько cookie могут прийти одной строкой через запятую (а в expires тоже есть запятая)
      String(line).split(/,(?=\s*[A-Za-z0-9_\-]+=)/).forEach(function (c) {
        var pair = c.split(';')[0].trim();
        if (pair.indexOf('=') > 0) pairs.push(pair);
      });
    });
    if (!pairs.length) return;
    Lampa.Storage.set(PREFIX + 'auto_cookie', mergeCookies(cfg('auto_cookie'), pairs.join('; ')));
    log('cookies saved', pairs.map(function (p) { return p.split('=')[0]; }).join(','));
  }

  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function isLoginPage(html) {
    return /id="loginForm"|<title>\s*Вход на/i.test(html);
  }

  function login(onOk, onErr) {
    var user = cfg('login');
    var pass = cfg('password');
    if (!user || !pass) return onErr('укажите логин и пароль в Настройки → Loki');

    request('/ajax/login/', {
      login_name: user,
      login_password: pass,
      login_not_save: 0
    }, host() + '/login/', function (text) {
      var json = parseJson(text);
      if (json && json.success) {
        // Диагностика режима без прокси: если приложение не отдало заголовки, cookie сохранить нечем.
        if (!/dle_user_id=/.test(cfg('auto_cookie'))) {
          noty('вход принят, но приложение не отдало cookie (returnHeaders не поддерживается)');
        }
        return onOk();
      }
      var msg = json && json.message;
      if (msg && typeof msg === 'object') {
        var parts = [];
        for (var k in msg) if (msg.hasOwnProperty(k)) parts.push(msg[k]);
        msg = parts.join(', ');
      }
      onErr('вход не удался' + (msg ? ': ' + msg : ''));
    }, onErr);
  }

  /** GET страницы; если сайт показал форму входа — логинимся и повторяем один раз. */
  function getPage(url, onOk, onErr, retried) {
    request(url, null, host() + '/', function (html) {
      if (isLoginPage(html)) {
        if (retried) return onErr('сайт не пускает после входа (проверьте логин/пароль или cookie)');
        return login(function () { getPage(url, onOk, onErr, true); }, onErr);
      }
      onOk(html);
    }, onErr);
  }

  /** POST к ajax-методу; при неудаче один раз перелогиниваемся. */
  function ajax(path, post, referer, onOk, onErr, retried) {
    request(path, post, referer, function (text) {
      var json = parseJson(text);
      if (json && json.success) return onOk(json);
      if (!retried && (!json || isLoginPage(text))) {
        return login(function () { ajax(path, post, referer, onOk, onErr, true); }, onErr);
      }
      onErr((json && json.message) || 'неожиданный ответ сайта');
    }, onErr);
  }

  // ---------- разбор ссылок на видео ----------

  var TRASH = (function () {
    var chars = ['@', '#', '!', '^', '$'];
    var list = [];
    var i, j, k;
    for (i = 0; i < chars.length; i++) for (j = 0; j < chars.length; j++) {
      list.push(btoa(chars[i] + chars[j]));
      for (k = 0; k < chars.length; k++) list.push(btoa(chars[i] + chars[j] + chars[k]));
    }
    return list;
  })();

  function decodeStreams(data) {
    if (!data || typeof data !== 'string') return '';
    if (data.indexOf('#h') !== 0) return data;
    var s = data.slice(2).split('//_//').join('');
    for (var i = 0; i < TRASH.length; i++) s = s.split(TRASH[i]).join('');
    while (s.length % 4) s += '=';
    try {
      return decodeURIComponent(escape(atob(s)));
    } catch (e) {
      try { return atob(s); } catch (e2) { return ''; }
    }
  }

  /** "[720p]a.m3u8 or b.mp4,[1080p]..." → [{label:'720p', url:'b.mp4'}, ...] */
  function parseQualities(decoded) {
    var out = [];
    var re = /\[([^\]]+)\]([^\[]+)/g;
    var m;
    while ((m = re.exec(decoded))) {
      var links = m[2].replace(/,\s*$/, '').split(/\s+or\s+/);
      var mp4 = null, any = null;
      for (var i = 0; i < links.length; i++) {
        var l = links[i].trim().replace(/,$/, '');
        if (!l || l === 'null') continue;
        if (!any) any = l;
        // берём ПЕРВУЮ mp4: дальше идут ссылки на запасное зеркало, которое часто не работает
        if (!mp4 && /\.mp4$/i.test(l)) mp4 = l;
      }
      var pick = cfg('prefer_hls') === true || cfg('prefer_hls') === 'true' ? any : (mp4 || any);
      if (pick) out.push({ label: m[1].replace(/<[^>]+>/g, '').trim(), url: pick });
    }
    return out;
  }

  // ---------- разбор HTML ----------

  function unescapeHtml(s) {
    return String(s || '')
      .replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function attr(tag, name) {
    var m = new RegExp(name + '="([^"]*)"').exec(tag);
    return m ? m[1] : '';
  }

  function parseSearch(html) {
    var out = [];
    var re = /<li><a href="([^"]+)"><span class="enty">([\s\S]*?)<\/span>([\s\S]*?)<\/a><\/li>/g;
    var m;
    while ((m = re.exec(html))) {
      var extra = m[3].replace(/<span class="rating">[\s\S]*?<\/span>/g, '');
      out.push({ url: m[1], title: unescapeHtml(m[2]), info: unescapeHtml(extra) });
    }
    return out;
  }

  /** страница полного поиска сайта: карточки результатов и есть ли следующая страница */
  function parseFullSearch(html) {
    var out = [];
    var parts = String(html).split('<div class="b-content__inline_item"');
    for (var i = 1; i < parts.length; i++) {
      var p = parts[i];
      var url = /data-url="([^"]+)"/.exec(p);
      var link = /<div class="b-content__inline_item-link">\s*<a href="([^"]+)">([\s\S]*?)<\/a>\s*<div>([\s\S]*?)<\/div>/.exec(p);
      if (!url && !link) continue;
      var type = /<i class="entity">([^<]*)<\/i>/.exec(p);
      var img = /<img src="([^"]+)"/.exec(p);
      out.push({
        url: url ? url[1] : link[1],
        title: link ? unescapeHtml(link[2]).trim() : '',
        info: link ? unescapeHtml(link[3]).trim() : '',
        type: type ? unescapeHtml(type[1]).trim() : '',
        poster: img ? img[1] : ''
      });
    }
    return { items: out, hasNext: /<a [^>]*>\s*<span class="b-navigation__next/.test(html) };
  }

  function parseMoviePage(html) {
    var info = { series: false };
    var m = /initCDNSeriesEvents\(\s*(\d+)\s*,\s*(\d+)/.exec(html);
    if (m) {
      info.series = true;
    } else {
      m = /initCDNMoviesEvents\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(html);
      if (m) {
        info.camrip = m[3]; info.ads = m[4]; info.director = m[5];
      }
    }
    if (!m) return null;
    info.id = m[1];
    info.defaultTranslator = m[2];

    var favs = /id="ctrl_favs"[^>]*value="([^"]+)"/.exec(html) || /value="([^"]+)"[^>]*id="ctrl_favs"/.exec(html);
    info.favs = favs ? favs[1] : '';

    var streams = /"streams"\s*:\s*"([^"]+)"/.exec(html);
    info.defaultStreams = streams ? streams[1].replace(/\\\//g, '/') : '';

    // оригинальное название — чтобы отметки просмотра совпадали с карточками Lampa
    var ot = /<div class="b-post__origtitle"[^>]*>([\s\S]*?)<\/div>/.exec(html);
    info.origTitle = ot ? unescapeHtml(ot[1].replace(/<[^>]+>/g, '')).split(' / ')[0].trim() : '';

    info.translators = [];
    var list = /id="translators-list"[\s\S]*?<\/ul>/.exec(html);
    if (list) {
      var re = /<li([^>]*data-translator_id="\d+"[^>]*)>([\s\S]*?)<\/li>/g;
      var t;
      while ((t = re.exec(list[0]))) {
        var tag = t[1];
        info.translators.push({
          id: attr(tag, 'data-translator_id'),
          title: unescapeHtml(attr(tag, 'title') || t[2]) || 'Озвучка',
          camrip: attr(tag, 'data-camrip') || 0,
          ads: attr(tag, 'data-ads') || 0,
          director: attr(tag, 'data-director') || 0
        });
      }
    }
    if (!info.translators.length) {
      info.translators.push({
        id: info.defaultTranslator, title: 'По умолчанию',
        camrip: info.camrip || 0, ads: info.ads || 0, director: info.director || 0
      });
    }
    parseDetails(html, info);
    return info;
  }

  /** постер, описание, рейтинги и строки таблицы «Дата выхода/Страна/Жанр/Время» — для шапки экрана */
  function parseDetails(html, info) {
    var strip = function (x) { return unescapeHtml(String(x || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim(); };
    var m = /<div class="b-sidecover">[\s\S]*?<img[^>]+src="([^"]+)"/.exec(html);
    info.poster = m ? m[1] : '';
    m = /<div class="b-post__description_text">([\s\S]*?)<\/div>/.exec(html);
    info.description = m ? strip(m[1]) : '';
    m = /b-post__info_rates imdb[\s\S]*?<span class="bold">([\d.,]+)<\/span>/.exec(html);
    info.imdb = m ? m[1] : '';
    m = /b-post__info_rates kp[\s\S]*?<span class="bold">([\d.,]+)<\/span>/.exec(html);
    info.kp = m ? m[1] : '';
    var row = function (label) {
      var r = new RegExp('<h2>' + label + '<\\/h2>:?<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>').exec(html);
      return r ? strip(r[1]) : '';
    };
    var date = row('Дата выхода');
    var y = /(\d{4})/.exec(date);
    info.year = y ? y[1] : '';
    info.country = row('Страна');
    info.genre = row('Жанр');
    info.duration = row('Время');
  }

  function parseEpisodes(html) {
    var seasons = {};
    var order = [];
    var re = /<li([^>]*class="b-simple_episode__item[^"]*"[^>]*)>([\s\S]*?)<\/li>/g;
    var m;
    while ((m = re.exec(html || ''))) {
      var s = attr(m[1], 'data-season_id');
      var e = attr(m[1], 'data-episode_id');
      if (!seasons[s]) { seasons[s] = []; order.push(s); }
      seasons[s].push({ season: s, episode: e, title: unescapeHtml(m[2]) || ('Серия ' + e) });
    }
    return { order: order, seasons: seasons };
  }

  // ---------- память (озвучка для каждого тайтла) ----------

  function memGet(key) {
    try { return JSON.parse(localStorage.getItem(PREFIX + key) || '{}') || {}; } catch (e) { return {}; }
  }

  function memSet(key, obj) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(obj)); } catch (e) {}
  }

  function rememberTranslator(info, translator) {
    var all = memGet('translators');
    all[info.id] = String(translator.id);
    memSet('translators', all);
  }

  function rememberedTranslator(info) {
    var id = memGet('translators')[info.id];
    if (!id) return null;
    for (var i = 0; i < info.translators.length; i++) {
      if (String(info.translators[i].id) === id) return info.translators[i];
    }
    return null;
  }

  // ---------- UI ----------

  var prevController = 'full_start';
  var currentMovie = {};

  function restoreController() {
    Lampa.Controller.toggle(prevController);
  }

  function select(title, items, onSelect) {
    Lampa.Select.show({
      title: title,
      items: items,
      onSelect: function (item) { onSelect(item); },
      onBack: restoreController
    });
  }

  function fail(msg) {
    Lampa.Loading.stop();
    noty(msg);
    restoreController();
  }

  function loading() {
    Lampa.Loading.start(function () { Lampa.Loading.stop(); });
  }

  /** число строк качества: "1080p Ultra" → 1080, "4K" → 2160 */
  function qualityHeight(label) {
    if (/4k/i.test(label)) return 2160;
    if (/2k/i.test(label)) return 1440;
    var m = /(\d{3,4})/.exec(label);
    return m ? parseInt(m[1], 10) : 0;
  }

  /** выбор качества по настройке; null — спросить у пользователя */
  function autoQuality(qualities) {
    var pref = String(cfg('quality', 'max') || 'max');
    if (pref === 'ask') return null;
    var limit = pref === 'max' ? 100000 : parseInt(pref, 10) || 100000;
    var best = null;
    for (var i = 0; i < qualities.length; i++) {
      var h = qualityHeight(qualities[i].label);
      if (h <= limit && (!best || h >= qualityHeight(best.label))) best = qualities[i];
    }
    return best || qualities[0];
  }

  function qualityMap(qualities) {
    var map = {};
    for (var i = 0; i < qualities.length; i++) map[qualities[i].label] = qualities[i].url;
    return map;
  }

  /** картинка TMDB через Lampa (учитывает её прокси картинок), иначе напрямую */
  function tmdbImg(path, size) {
    if (!path) return '';
    try { if (Lampa.Api && Lampa.Api.img) return Lampa.Api.img(path, size); } catch (e) {}
    return 'https://image.tmdb.org/t/p/' + size + path;
  }

  /** серии сезона из TMDB (названия, кадры) через встроенный клиент Lampa; только для карточек Lampa */
  function tmdbSeason(movie, season, cb) {
    var done = false;
    var finish = function (eps) { if (!done) { done = true; cb(eps || []); } };
    try {
      if (!movie.id || !(movie.name || movie.original_name) || !Lampa.Api || !Lampa.Api.seasons) return finish([]);
      Lampa.Api.seasons(movie, [parseInt(season, 10)], function (res) {
        var x = res && (res[season] || res[parseInt(season, 10)]);
        finish(x && x.episodes);
      });
    } catch (e) { finish([]); }
  }

  /** фон приложения Lampa (тот же слой, что на карточке фильма) */
  function setBackground(url) {
    if (!url) return;
    try { Lampa.Background.change(url); } catch (e) {}
  }

  /** отметка прогресса Lampa (тот же хэш, что у встроенных онлайн-источников) */
  function timeline(season, episode) {
    try {
      var orig = currentMovie.original_title || currentMovie.original_name || currentMovie.title || currentMovie.name || '';
      var hash = season
        ? Lampa.Utils.hash([season, season > 10 ? ':' : '', episode, orig].join(''))
        : Lampa.Utils.hash(orig);
      return Lampa.Timeline.view(hash);
    } catch (e) {
      return undefined;
    }
  }

  /**
   * Запуск плеера. extra.season/episode — для сериала,
   * extra.onStart(video) — вызывается сразу после старта (для подгрузки следующих серий).
   */
  function play(title, encoded, extra) {
    extra = extra || {};
    var qualities = parseQualities(decodeStreams(encoded));
    if (!qualities.length) return fail('не нашёл ссылок на видео в ответе сайта');

    var go = function (url) {
      var video = {
        title: title,
        url: url,
        quality: qualityMap(qualities),
        timeline: timeline(extra.season, extra.episode)
      };
      playCtx = extra.ctx || null;   // до play(): кнопки панели читают его в обработчике 'start'
      Lampa.Player.play(video);
      Lampa.Player.playlist([video]);
      if (extra.onStart) extra.onStart(video);
    };

    var auto = autoQuality(qualities);
    if (auto) return go(auto.url);

    select('Качество', qualities.map(function (q) {
      return { title: q.label, url: q.url };
    }).reverse(), function (item) { go(item.url); });
  }

  function getStream(page, info, translator, ep, onOk, onErr) {
    ajax('/ajax/get_cdn_series/?t=' + Date.now(), {
      id: info.id, translator_id: translator.id, season: ep.season, episode: ep.episode,
      favs: info.favs, action: 'get_stream'
    }, page.url, function (res) { onOk(res.url); }, onErr);
  }

  // ---------- автопереход: заранее подгружаем ссылки следующих серий ----------

  var PREFETCH_AHEAD = 2;   // сколько серий держать готовыми впереди
  var session = null;       // текущий просмотр сериала

  /**
   * Плейлист с готовыми ссылками. Сначала текущая серия, затем по мере загрузки
   * добавляются следующие (по одной, последовательно) и плейлист плеера обновляется.
   * Когда плеер переходит на очередную серию, окно подгрузки сдвигается дальше.
   */
  function startSession(page, info, translator, episodes, index, movieTitle, firstVideo) {
    session = {
      page: page, info: info, translator: translator, episodes: episodes, movieTitle: movieTitle,
      items: [firstVideo], startIndex: index, loading: false, failed: false
    };
    prefetch(session, index);
  }

  function prefetch(s, playingIndex) {
    if (s !== session || s.loading || s.failed) return;
    var nextIndex = s.startIndex + s.items.length;          // первая ещё не загруженная серия
    if (nextIndex >= s.episodes.length) return;             // сезон кончился
    if (nextIndex > playingIndex + PREFETCH_AHEAD) return;  // впереди уже достаточно

    var e = s.episodes[nextIndex];
    s.loading = true;
    getStream(s.page, s.info, s.translator, e, function (encoded) {
      s.loading = false;
      if (s !== session) return;
      var qs = parseQualities(decodeStreams(encoded));
      if (!qs.length) { s.failed = true; return; }
      s.items.push({
        title: s.movieTitle + ' — S' + e.season + 'E' + e.episode,
        url: (autoQuality(qs) || qs[qs.length - 1]).url,
        quality: qualityMap(qs),
        timeline: timeline(e.season, e.episode)
      });
      try { Lampa.Player.playlist(s.items.slice()); } catch (err) { log('playlist update error', err); }
      log('prefetched S' + e.season + 'E' + e.episode);
      prefetch(s, playingIndex);
    }, function (err) {
      s.loading = false;
      s.failed = true;
      log('prefetch error', err);
    });
  }

  /** плеер начал очередной элемент — сдвигаем окно подгрузки */
  function onPlayerStart(data) {
    var s = session;
    if (!s || !data) return;
    var url = data.url || (data.data && data.data.url);
    for (var i = 0; i < s.items.length; i++) {
      if (s.items[i].url === url) {
        if (playCtx) { playCtx.ep = s.episodes[s.startIndex + i]; playCtx.translator = s.translator; }
        return prefetch(s, s.startIndex + i);
      }
    }
  }

  var playCtx = null;        // что сейчас играет: { page, info, translator, movieTitle, ep? }

  // ---------- кнопка «Назад» в панели плеера ----------

  var BACK_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>';
  var playerClosedAt = 0;

  /** кладём кнопку в левую часть панели плеера Lampa; панель собирает .selector при каждом показе */
  function addPlayerBackButton() {
    try {
      var left = Lampa.Player.render().find('.player-panel__left');
      if (!left.length || left.find('.loki-player-back').length) return;
      var b = $('<div class="button selector loki-player-back">' + BACK_SVG + '<span>Назад</span></div>');
      b.on('hover:enter', function () { Lampa.Player.close(); });
      left.prepend(b);
      if (!document.getElementById('loki-player-css')) {
        var st = document.createElement('style');
        st.id = 'loki-player-css';
        st.textContent = '.loki-player-back{display:flex;align-items:center;width:auto!important;padding:0 .8em}' +
          '.loki-player-back svg{width:1.4em;height:1.4em}.loki-player-back span{margin-left:.4em}' +
          '.loki-player-voice{display:flex;align-items:center;justify-content:center}.loki-player-voice svg{width:1.4em;height:1.4em}';
        document.head.appendChild(st);
      }
    } catch (e) { log('player back button error', e); }
  }

  // ---------- кнопка «Озвучка» (микрофон) в панели плеера ----------

  var MIC_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';

  /** кнопка рядом с «Качеством»; только когда играет наше видео и озвучек больше одной */
  function addPlayerVoiceButton() {
    try {
      var panel = Lampa.Player.render();
      panel.find('.loki-player-voice').remove();
      if (!playCtx || !playCtx.info || playCtx.info.translators.length < 2) return;
      var b = $('<div class="button selector loki-player-voice">' + MIC_SVG + '</div>');
      b.on('hover:enter', pickVoiceInPlayer);
      var quality = panel.find('.player-panel__right .player-panel__quality').first();
      if (quality.length) quality.before(b);
      else panel.find('.player-panel__right').first().prepend(b);
    } catch (e) { log('player voice button error', e); }
  }

  function pickVoiceInPlayer() {
    var ctx = playCtx;
    if (!ctx) return;
    var enabled = 'player_panel';
    try { enabled = Lampa.Controller.enabled().name; } catch (e) {}
    Lampa.Select.show({
      title: 'Озвучка',
      items: ctx.info.translators.map(function (t) {
        return { title: t.title, tr: t, selected: String(t.id) === String(ctx.translator.id) };
      }),
      onSelect: function (item) {
        Lampa.Controller.toggle(enabled);
        if (String(item.tr.id) !== String(ctx.translator.id)) switchVoice(ctx, item.tr);
      },
      onBack: function () { Lampa.Controller.toggle(enabled); }
    });
  }

  /** меняем озвучку не закрывая плеер — тем же путём, что встроенная смена качества */
  function switchVoice(ctx, tr) {
    var v = null;
    try { v = Lampa.PlayerVideo.video(); } catch (e) {}
    var pos = v && v.currentTime ? v.currentTime : 0;
    noty('озвучка: ' + tr.title + '…');

    var onEncoded = function (encoded) {
      if (ctx !== playCtx) return; // плеер уже закрыт или запущено другое видео
      var qs = parseQualities(decodeStreams(encoded));
      if (!qs.length) return noty('нет ссылок на видео для этой озвучки');
      var q = autoQuality(qs) || qs[qs.length - 1];
      var qmap = qualityMap(qs);

      ctx.translator = tr;
      rememberTranslator(ctx.info, tr);

      var work = null;
      try { work = Lampa.Player.playdata(); } catch (e) {}
      if (work) {
        work.quality = qmap;
        if (work.timeline && pos > 0) work.timeline.time = pos;
      }

      // сериал: плейлист и подгрузку следующих серий начинаем заново уже с новой озвучкой
      var s = session;
      if (s && ctx.ep) {
        var idx = s.episodes.indexOf(ctx.ep);
        if (idx >= 0) {
          var cur = { title: work ? work.title : s.movieTitle, url: q.url, quality: qmap, timeline: work ? work.timeline : timeline(ctx.ep.season, ctx.ep.episode) };
          session = { page: s.page, info: s.info, translator: tr, episodes: s.episodes, movieTitle: s.movieTitle,
            items: [cur], startIndex: idx, loading: false, failed: false };
        }
      }

      var switched = false;
      try {
        if (Lampa.PlayerPanel.listener) {
          Lampa.PlayerPanel.listener.send('quality', { name: q.label, url: q.url });
          switched = true;
        }
      } catch (e) { log('quality-path switch failed', e); }
      if (!switched) {
        if (work) work.url = q.url;
        Lampa.PlayerVideo.url(q.url, true);
      }
      try { Lampa.PlayerPanel.quality(qmap, q.url); } catch (e) {}
      if (session && session.translator === tr) {
        try { Lampa.Player.playlist(session.items.slice()); } catch (e) {}
        prefetch(session, session.startIndex);
      }
      seekWhenReady(pos);
      addPlayerVoiceButton();
    };

    var onErr = function (err) { if (ctx === playCtx) noty(err); };
    if (ctx.ep) getStream(ctx.page, ctx.info, tr, ctx.ep, onEncoded, onErr);
    else getMovieStream(ctx.page, ctx.info, tr, onEncoded, onErr);
  }

  /** после смены источника возвращаемся на ту же секунду (если плеер сам этого не сделал) */
  function seekWhenReady(pos) {
    if (!(pos > 10)) return;
    var v = null;
    try { v = Lampa.PlayerVideo.video(); } catch (e) {}
    if (!v || !v.addEventListener) return;
    var done = false;
    var handler = function () {
      if (done) return;
      done = true;
      v.removeEventListener('canplay', handler);
      v.removeEventListener('loadedmetadata', handler);
      if (Math.abs((v.currentTime || 0) - pos) > 5) {
        try { Lampa.PlayerVideo.to(pos); } catch (e) { try { v.currentTime = pos; } catch (e2) {} }
      }
    };
    v.addEventListener('loadedmetadata', handler);
    v.addEventListener('canplay', handler);
  }

  // ---------- кнопка перезапуска Lampa в шапке ----------

  var RESTART_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';

  function addRestartButton() {
    try {
      var actions = $('.head__actions').first();
      if (!actions.length) return;
      // у другого плагина может быть своя кнопка перезапуска — тогда вторую не добавляем
      if (actions.find('.loki-restart, [class*="reload"], [class*="restart"], [data-action="reload"], [data-action="restart"]').length) return;
      var b = $('<div class="head__action selector loki-restart" title="Перезапустить Lampa">' + RESTART_SVG + '</div>');
      b.on('hover:enter', function () { window.location.reload(); });
      var profile = actions.find('.open--profile').first();
      if (profile.length) profile.before(b);
      else actions.append(b);
    } catch (e) { log('restart button error', e); }
  }

  function onPlayerDestroy() {
    session = null;
    playCtx = null;
  }

  function chooseTranslator(info, onPick) {
    var last = rememberedTranslator(info);
    var current = last ? String(last.id) : String(info.defaultTranslator);
    select('Озвучка', info.translators.map(function (t) {
      return { title: t.title, tr: t, selected: String(t.id) === current };
    }), function (item) {
      rememberTranslator(info, item.tr);
      onPick(item.tr);
    });
  }

  function chooseEpisode(page, info, translator, movieTitle) {
    loading();
    ajax('/ajax/get_cdn_series/?t=' + Date.now(), {
      id: info.id, translator_id: translator.id, favs: info.favs, action: 'get_episodes'
    }, page.url, function (json) {
      Lampa.Loading.stop();
      var eps = parseEpisodes(json.episodes);
      if (!eps.order.length) return fail('список серий пуст');

      var changeItem = info.translators.length > 1
        ? [{ title: '🔊 ' + translator.title, subtitle: 'сменить озвучку', change: true }]
        : [];
      var onChange = function () {
        chooseTranslator(info, function (t) { chooseEpisode(page, info, t, movieTitle); });
      };

      var pickSeason = function (season) {
        var list = eps.seasons[season];
        select('Сезон ' + season, changeItem.concat(list.map(function (e, idx) {
          return { title: e.title, ep: e, idx: idx };
        })), function (item) {
          if (item.change) return onChange();
          var e = item.ep;
          loading();
          getStream(page, info, translator, e, function (encoded) {
            Lampa.Loading.stop();
            play(movieTitle + ' — S' + e.season + 'E' + e.episode, encoded, {
              season: e.season,
              episode: e.episode,
              ctx: { page: page, info: info, translator: translator, movieTitle: movieTitle, ep: e },
              onStart: function (video) {
                startSession(page, info, translator, list, item.idx, movieTitle, video);
              }
            });
          }, fail);
        });
      };

      if (eps.order.length === 1) return pickSeason(eps.order[0]);
      select('Сезон', changeItem.concat(eps.order.map(function (s) {
        return { title: 'Сезон ' + s, season: s };
      })), function (item) {
        if (item.change) return onChange();
        pickSeason(item.season);
      });
    }, fail);
  }

  /** ссылки фильма для озвучки; при ошибке — встроенные в страницу (для озвучки по умолчанию) */
  function getMovieStream(page, info, translator, onOk, onErr) {
    ajax('/ajax/get_cdn_series/?t=' + Date.now(), {
      id: info.id, translator_id: translator.id,
      is_camrip: translator.camrip, is_ads: translator.ads, is_director: translator.director,
      favs: info.favs, action: 'get_movie'
    }, page.url, function (json) { onOk(json.url); }, function (err) {
      if (String(translator.id) === String(info.defaultTranslator) && info.defaultStreams) return onOk(info.defaultStreams);
      onErr(err);
    });
  }

  function playMovie(page, info, translator, movieTitle) {
    loading();
    getMovieStream(page, info, translator, function (encoded) {
      Lampa.Loading.stop();
      play(movieTitle, encoded, { ctx: { page: page, info: info, translator: translator, movieTitle: movieTitle } });
    }, fail);
  }

  function openPage(page, movieTitle) {
    loading();
    getPage(page.url, function (html) {
      Lampa.Loading.stop();
      var info = parseMoviePage(html);
      if (!info) return fail('не удалось разобрать страницу фильма');

      var next = function (translator) {
        if (info.series) chooseEpisode(page, info, translator, movieTitle);
        else playMovie(page, info, translator, movieTitle);
      };

      if (info.translators.length === 1) return next(info.translators[0]);

      // сериал: сразу берём запомненную озвучку (сменить можно пунктом в списке серий)
      var last = rememberedTranslator(info);
      if (info.series && last) return next(last);

      chooseTranslator(info, next);
    }, fail);
  }

  /** Поиск тайтла на сайте: onOk(results, exactMatch|null) */
  function searchSite(movie, onOk, onErr) {
    var query = movie.title || movie.name || movie.original_title || movie.original_name;
    var year = String(movie.release_date || movie.first_air_date || '').slice(0, 4);
    if (!query) return onErr('у карточки нет названия');

    var doSearch = function (q, triedOriginal, triedLogin) {
      request('/engine/ajax/search.php', { q: q }, host() + '/', function (html) {
        if (isLoginPage(html) && !triedLogin) {
          return login(function () { doSearch(q, triedOriginal, true); }, onErr);
        }
        var results = parseSearch(html);
        var orig = movie.original_title || movie.original_name;
        if (!results.length && !triedOriginal && orig && orig !== q) return doSearch(orig, true, triedLogin);
        if (!results.length) return onErr('ничего не найдено по «' + q + '»');

        var exact = year ? results.filter(function (r) { return r.info.indexOf(year) !== -1; }) : [];
        onOk(results, exact.length === 1 ? exact[0] : (results.length === 1 ? results[0] : null));
      }, onErr);
    };
    doSearch(query, false, false);
  }

  /** старый интерфейс: цепочка окон Lampa.Select */
  function start(movie) {
    try { prevController = Lampa.Controller.enabled().name || 'full_start'; } catch (e) {}
    currentMovie = movie || {};
    loading();
    searchSite(currentMovie, function (results, exact) {
      Lampa.Loading.stop();
      if (exact) return openPage(exact, movie.title || movie.name || exact.title);
      select('Найдено', results.map(function (r) {
        return { title: r.title, subtitle: r.info, page: r };
      }), function (item) { openPage(item.page, item.page.title); });
    }, fail);
  }

  // ---------- экран со списком серий ----------

  var ACCENT = '#5fd68a';
  var CSS = '' +
    '.loki-screen{padding:2em 3.5em 4em}' +
    '.loki-screen__head{font-size:2em;font-weight:700;margin-bottom:.25em}' +
    '.loki-screen__sub{opacity:.6;margin-bottom:1.4em}' +
    // шапка фильма
    '.loki-hero{display:flex;align-items:flex-end;margin-bottom:2em;min-height:19em}' +
    '.loki-hero__poster{width:13em;height:19.5em;border-radius:1.2em;background:rgba(255,255,255,.06) center/cover no-repeat;flex-shrink:0;margin-right:2.5em;box-shadow:0 .8em 2em rgba(0,0,0,.5)}' +
    '.loki-hero__body{flex:1;min-width:0;padding-top:.3em}' +
    '.loki-hero__title{font-size:3.2em;font-weight:800;line-height:1.1;text-shadow:0 .1em .4em rgba(0,0,0,.5)}' +
    '.loki-hero__orig{opacity:.6;margin-top:.35em;font-size:1.2em}' +
    '.loki-hero__meta{display:flex;flex-wrap:wrap;align-items:center;margin-top:.9em}' +
    '.loki-chip{padding:.3em .8em;border-radius:.5em;background:rgba(0,0,0,.35);margin:0 .6em .6em 0;font-size:1.05em;white-space:nowrap}' +
    '.loki-chip--imdb{background:#f5c518;color:#000;font-weight:700}' +
    '.loki-chip--kp{background:#ff6a00;color:#fff;font-weight:700}' +
    '.loki-hero__descr{margin-top:.6em;opacity:.85;font-size:1.1em;line-height:1.5;max-width:52em;text-shadow:0 .05em .3em rgba(0,0,0,.6);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}' +
    // кнопки
    '.loki-row{display:flex;flex-wrap:wrap;margin-bottom:1.6em}' +
    '.loki-btn{padding:.7em 1.5em;border-radius:2em;font-size:1.1em;background:rgba(0,0,0,.4);margin:0 .8em .6em 0;transition:transform .15s,background .15s}' +
    '.loki-btn.focus{background:#fff;color:#000;transform:scale(1.06);box-shadow:0 .4em 1.2em rgba(0,0,0,.4)}' +
    // строки серий
    '.loki-item{display:flex;align-items:center;max-width:62em;padding:.85em 1.2em;margin-bottom:.6em;border-radius:1em;background:rgba(255,255,255,.05);transition:transform .15s,background .15s}' +
    '.loki-item.focus{background:#fff;color:#000;transform:scale(1.015);box-shadow:0 .5em 1.4em rgba(0,0,0,.45)}' +
    '.loki-item__num{width:2.3em;height:2.3em;line-height:2.3em;border-radius:50%;background:rgba(255,255,255,.1);text-align:center;font-weight:700;flex-shrink:0;margin-right:1.1em}' +
    '.loki-item.focus .loki-item__num{background:rgba(0,0,0,.1)}' +
    '.loki-item__body{flex:1;min-width:0}' +
    '.loki-item__title{font-size:1.2em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.loki-item__meta{font-size:.9em;opacity:.6;margin-top:.2em}' +
    '.loki-item__meta:empty{display:none}' +
    '.loki-item__bar{height:.28em;background:rgba(255,255,255,.12);border-radius:.2em;margin-top:.5em;overflow:hidden}' +
    '.loki-item.focus .loki-item__bar{background:rgba(0,0,0,.12)}' +
    '.loki-item__bar>div{height:100%;background:' + ACCENT + '}' +
    '.loki-item--watched .loki-item__num{background:' + ACCENT + ';color:#000}' +
    '.loki-item--watched .loki-item__title{opacity:.6}' +
    '.loki-item--watched.focus .loki-item__title{opacity:1}' +
    '.loki-item--primary{background:' + ACCENT + ';color:#000;max-width:24em;font-size:1.15em;padding:1em 1.4em}' +
    '.loki-item--primary .loki-item__num{background:rgba(0,0,0,.15)}' +
    '.loki-item--primary .loki-item__title{font-weight:700}' +
    '.loki-item--primary .loki-item__bar{background:rgba(0,0,0,.15)}' +
    '.loki-item--primary .loki-item__bar>div{background:#000}' +
    '.loki-item__poster{width:2.8em;height:4.2em;object-fit:cover;border-radius:.4em;margin-right:1em;flex-shrink:0;background:rgba(255,255,255,.08)}' +
    // карточки серий
    '.loki-eps{display:flex;flex-wrap:wrap;margin:0 -.6em}' +
    '.loki-ep{width:17em;margin:0 .6em 1.5em;transition:transform .15s}' +
    '.loki-ep__img{position:relative;height:9.6em;border-radius:.9em;overflow:hidden;background:rgba(0,0,0,.4) center/cover no-repeat}' +
    '.loki-ep .loki-item__num{position:absolute;left:.6em;top:.6em;width:auto;min-width:2.2em;height:2.2em;line-height:2.2em;padding:0 .5em;border-radius:1.1em;background:rgba(0,0,0,.6);color:#fff;text-align:center;font-weight:700;margin:0}' +
    '.loki-ep__img:not(.loki-ep__img--still) .loki-item__num{left:50%;top:50%;transform:translate(-50%,-50%);font-size:2.2em;background:none;opacity:.5}' +
    '.loki-ep.loki-item--watched .loki-item__num{background:' + ACCENT + ';color:#000;opacity:1;font-size:1em;left:.6em;top:.6em;transform:none}' +
    '.loki-ep .loki-item__bar{position:absolute;left:0;right:0;bottom:0;margin:0;height:.3em;border-radius:0;background:rgba(0,0,0,.5)}' +
    '.loki-ep .loki-item__title{margin-top:.6em;font-size:1.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.loki-ep .loki-item__meta{font-size:.85em;opacity:.55;margin-top:.2em}' +
    '.loki-ep.loki-item--watched .loki-ep__img{opacity:.55}' +
    '.loki-ep.focus{transform:scale(1.06)}' +
    '.loki-ep.focus .loki-ep__img{opacity:1;box-shadow:0 0 0 .2em #fff,0 .8em 2em rgba(0,0,0,.6)}' +
    '.loki-msg{padding:3em 1em;text-align:center;opacity:.7;font-size:1.2em}' +
    // поиск: строка запроса и сетка постеров
    '.loki-searchbar{display:flex;align-items:center;padding:.8em 1.3em;border-radius:1em;background:rgba(255,255,255,.08);margin-bottom:1.6em;max-width:40em;font-size:1.15em;transition:transform .15s,background .15s}' +
    '.loki-searchbar svg{width:1.3em;height:1.3em;margin-right:.8em;opacity:.7;flex-shrink:0}' +
    '.loki-searchbar--empty span{opacity:.5}' +
    '.loki-searchbar.focus{background:#fff;color:#000;transform:scale(1.02)}' +
    '.loki-searchbar.focus span{opacity:1}' +
    '.loki-grid{display:flex;flex-wrap:wrap;margin:0 -.6em}' +
    '.loki-card{width:10.2em;margin:0 .6em 1.4em;transition:transform .15s}' +
    '.loki-card__img{position:relative;height:15.3em;border-radius:.9em;background:rgba(255,255,255,.06) center/cover no-repeat;overflow:hidden}' +
    '.loki-card__type{position:absolute;left:.5em;top:.5em;padding:.15em .5em;border-radius:.4em;background:rgba(0,0,0,.65);font-size:.75em}' +
    '.loki-card__title{margin-top:.55em;font-size:1em;line-height:1.25;max-height:2.5em;overflow:hidden}' +
    '.loki-card__meta{font-size:.8em;opacity:.55;margin-top:.25em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.loki-card.focus{transform:scale(1.07)}' +
    '.loki-card.focus .loki-card__img{box-shadow:0 0 0 .2em #fff,0 .8em 2em rgba(0,0,0,.6)}' +
    '.loki-card--more .loki-card__img{display:flex;align-items:center;justify-content:center;font-size:1.3em;background:rgba(255,255,255,.08)}' +
    '.loki-card--more.focus .loki-card__img{background:#fff;color:#000}';

  function injectCss() {
    if (document.getElementById('player-by-loki-css')) return;
    var style = document.createElement('style');
    style.id = 'player-by-loki-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function minutes(sec) {
    return Math.max(1, Math.round((sec || 0) / 60)) + ' мин';
  }

  /** прогресс просмотра из Lampa.Timeline */
  function progressOf(season, episode) {
    var v = timeline(season, episode);
    if (!v) return { percent: 0, time: 0, duration: 0 };
    return { percent: v.percent || 0, time: v.time || 0, duration: v.duration || 0 };
  }

  /**
   * Стрелка вверх/вниз, когда прямо над/под элементом ничего нет (например, с 4-й серии вверх,
   * а кнопки стоят только слева): переходим на ближайший по горизонтали элемент соседней строки,
   * а не в шапку Lampa. Возвращает true, если переход сделан.
   */
  function jumpRow(container, current, dir) {
    if (!current || !current.getBoundingClientRect) return false;
    var cur = current.getBoundingClientRect();
    var cx = cur.left + cur.width / 2;
    var best = null, bestEdge = null, bestDx = 0;
    $(container).find('.selector').each(function () {
      if (this === current) return;
      var r = this.getBoundingClientRect();
      if (!r.width && !r.height) return; // скрытый
      var edge;
      if (dir === 'up') { if (r.bottom > cur.top + 2) return; edge = r.bottom; }
      else { if (r.top < cur.bottom - 2) return; edge = -r.top; }
      var dx = Math.abs(r.left + r.width / 2 - cx);
      // сначала ближайшая строка, внутри неё — ближайший по горизонтали
      if (best === null || edge > bestEdge + 2 || (Math.abs(edge - bestEdge) <= 2 && dx < bestDx)) {
        best = this; bestEdge = edge; bestDx = dx;
      }
    });
    if (!best) return false;
    Lampa.Controller.collectionFocus(best, container);
    return true;
  }

  function LokiScreen(object) {
    var self = this;
    var movie = object.movie || {};
    var title = movie.title || movie.name || movie.original_title || movie.original_name || '';
    var scroll = new Lampa.Scroll({ mask: true, over: true });
    var root = $('<div class="loki-screen-wrap"></div>');
    var body = $('<div class="loki-screen"></div>');
    var last = null;          // элемент в фокусе
    var progressRows = [];    // [{el, season, episode}] — для обновления после просмотра

    var st = { results: [], page: null, info: null, translator: null, eps: null, season: null };

    // ----- жизненный цикл компонента Lampa -----

    this.create = function () {
      injectCss();
      currentMovie = movie;
      // без этого Lampa не задаёт скроллу высоту (экран минус шапка) и длинный список уходит за экран
      scroll.minus();
      root.append(scroll.render());
      scroll.append(body);
      if (object.sitePage) self.openPage(object.sitePage);   // пришли из «Loki поиск»
      else this.search();
      return this.render();
    };

    this.render = function () { return root; };

    this.start = function () {
      try {
        if (Lampa.Activity.active().activity !== this.activity) return;
      } catch (e) {}
      prevController = 'content';
      currentMovie = movie;
      Lampa.Controller.add('content', {
        toggle: function () {
          prevController = 'content';
          syncTranslator();
          refreshProgress();
          Lampa.Controller.collectionSet(scroll.render());
          Lampa.Controller.collectionFocus(last || false, scroll.render());
        },
        up: function () {
          if (Navigator.canmove('up')) Navigator.move('up');
          else if (!jumpRow(scroll.render(), last, 'up')) Lampa.Controller.toggle('head');
        },
        down: function () {
          if (Navigator.canmove('down')) Navigator.move('down');
          else jumpRow(scroll.render(), last, 'down');
        },
        left: function () {
          if (Navigator.canmove('left')) Navigator.move('left');
          else Lampa.Controller.toggle('menu');
        },
        right: function () { Navigator.move('right'); },
        back: self.back
      });
      Lampa.Controller.toggle('content');
    };

    this.back = function () {
      // на некоторых пультах «Назад» из плеера приходит дважды — второе нажатие сразу после закрытия игнорируем
      if (Date.now() - playerClosedAt < 800) return;
      Lampa.Activity.backward();
    };
    this.pause = function () {};
    this.stop = function () {};
    this.destroy = function () {
      try { scroll.destroy(); } catch (e) {}
      root.remove();
    };

    // ----- отрисовка -----

    function loader(on) {
      try { self.activity.loader(on); } catch (e) {}
    }

    function focusable(el, onEnter) {
      el.on('hover:focus', function () {
        last = el[0];
        scroll.update(el, true);
      });
      el.on('hover:enter', onEnter);
      return el;
    }

    function redraw(blocks, focusEl) {
      body.empty();
      progressRows = [];
      for (var i = 0; i < blocks.length; i++) body.append(blocks[i]);
      last = focusEl ? focusEl[0] : (body.find('.selector')[0] || null);
      loader(false);
      try { Lampa.Layer.update(root[0]); } catch (e) {}
      try { self.activity.toggle(); } catch (e) { Lampa.Controller.toggle('content'); }
    }

    function head(sub) {
      return $('<div><div class="loki-screen__head">' + esc(title) + '</div>' +
        (sub ? '<div class="loki-screen__sub">' + esc(sub) + '</div>' : '') + '</div>');
    }

    function btn(text, onEnter) {
      return focusable($('<div class="loki-btn selector">' + esc(text) + '</div>'), onEnter);
    }

    /** шапка фильма: постер, названия, рейтинги, год/страна/жанр, описание. Без .selector — только оформление. */
    function hero(extraChip) {
      var i = st.info || {};
      var el = $('<div class="loki-hero"><div class="loki-hero__poster"></div><div class="loki-hero__body">' +
        '<div class="loki-hero__title"></div><div class="loki-hero__orig"></div>' +
        '<div class="loki-hero__meta"></div><div class="loki-hero__descr"></div></div></div>');
      var poster = tmdbImg(movie.poster_path, 'w500') || i.poster;
      if (poster) el.find('.loki-hero__poster').css('background-image', 'url("' + poster + '")');
      else el.find('.loki-hero__poster').remove();
      setBackground(tmdbImg(movie.backdrop_path, 'w1280') || i.poster);
      el.find('.loki-hero__title').text(title || (st.page && st.page.title) || '');
      if (i.origTitle && i.origTitle !== title) el.find('.loki-hero__orig').text(i.origTitle);
      else el.find('.loki-hero__orig').remove();
      var meta = el.find('.loki-hero__meta');
      var chip = function (text, cls) { if (text) meta.append($('<span class="loki-chip"></span>').addClass(cls || '').text(text)); };
      chip(i.imdb && 'IMDb ' + i.imdb, 'loki-chip--imdb');
      chip(i.kp && 'КП ' + i.kp, 'loki-chip--kp');
      chip(i.year);
      chip(i.country && i.country.split(',')[0]);
      chip(i.genre && i.genre.split(',').slice(0, 2).join(', '));
      chip(i.duration);
      chip(extraChip);
      if (!meta.children().length && st.page) chip(st.page.info);
      if (i.description) el.find('.loki-hero__descr').text(i.description);
      else el.find('.loki-hero__descr').remove();
      return el;
    }

    function row(buttons) {
      var r = $('<div class="loki-row"></div>');
      for (var i = 0; i < buttons.length; i++) if (buttons[i]) r.append(buttons[i]);
      return r;
    }

    function itemEl(num, titleText, meta, onEnter) {
      var el = $('<div class="loki-item selector">' +
        '<div class="loki-item__num">' + esc(num) + '</div>' +
        '<div class="loki-item__body">' +
        '<div class="loki-item__title">' + esc(titleText) + '</div>' +
        '<div class="loki-item__meta">' + esc(meta || '') + '</div>' +
        '<div class="loki-item__bar" style="display:none"><div></div></div>' +
        '</div></div>');
      return focusable(el, onEnter);
    }

    function applyProgress(el, p, num) {
      var meta = el.find('.loki-item__meta');
      var bar = el.find('.loki-item__bar');
      el.removeClass('loki-item--watched');
      el.find('.loki-item__num').text(num);
      if (p.percent >= 90) {
        el.addClass('loki-item--watched');
        el.find('.loki-item__num').text('✓');
        meta.text('просмотрено');
        bar.hide();
      } else if (p.percent > 0) {
        meta.text(p.duration ? minutes(p.time) + ' из ' + minutes(p.duration) : Math.round(p.percent) + '%');
        bar.show().children().css('width', Math.round(p.percent) + '%');
      } else {
        meta.text('');
        bar.hide();
      }
    }

    function refreshProgress() {
      for (var i = 0; i < progressRows.length; i++) {
        var r = progressRows[i];
        applyProgress(r.el, progressOf(r.season, r.episode), r.num);
      }
    }

    function message(text, retry) {
      var blocks = [head(), $('<div class="loki-msg">' + esc(text) + '</div>')];
      if (retry) blocks.push(row([btn('Повторить', retry)]));
      redraw(blocks);
    }

    function onError(err) {
      loader(false);
      message('Ошибка: ' + err, function () {
        if (object.sitePage) self.openPage(object.sitePage);
        else self.search();
      });
    }

    // ----- шаги -----

    this.search = function () {
      loader(true);
      searchSite(movie, function (results, exact) {
        st.results = results;
        if (exact) return self.openPage(exact);
        drawResults();
      }, onError);
    };

    function drawResults() {
      var blocks = [head('Выберите, что именно смотреть')];
      for (var i = 0; i < st.results.length; i++) {
        (function (r, n) {
          blocks.push(itemEl(n + 1, r.title, r.info, function () { self.openPage(r); }));
        })(st.results[i], i);
      }
      redraw(blocks);
    }

    this.openPage = function (page) {
      loader(true);
      st.page = page;
      getPage(page.url, function (html) {
        var info = parseMoviePage(html);
        if (!info) return onError('не удалось разобрать страницу');
        st.info = info;
        if (object.sitePage && info.origTitle && !movie.original_title) movie.original_title = info.origTitle;
        st.translator = rememberedTranslator(info) || findTranslator(info, info.defaultTranslator) || info.translators[0];
        if (info.series) loadEpisodes();
        else drawMovie();
      }, onError);
    };

    /** озвучку могли сменить в плеере — обновляем подпись кнопки (без перерисовки экрана) */
    function syncTranslator() {
      if (!st.info || !st.translator) return;
      var t = rememberedTranslator(st.info);
      if (!t || String(t.id) === String(st.translator.id)) return;
      st.translator = t;
      body.find('.loki-btn').each(function () {
        if ($(this).text().indexOf('🔊 ') === 0) $(this).text('🔊 ' + t.title);
      });
    }

    function findTranslator(info, id) {
      for (var i = 0; i < info.translators.length; i++) {
        if (String(info.translators[i].id) === String(id)) return info.translators[i];
      }
      return null;
    }

    function pickTranslator() {
      chooseTranslator(st.info, function (t) {
        st.translator = t;
        if (st.info.series) loadEpisodes();
        else drawMovie();
      });
    }

    function pickQuality(redrawFn) {
      var current = String(cfg('quality', 'max') || 'max');
      var keys = ['max', '2160', '1080', '720', '480', 'ask'];
      select('Качество', keys.map(function (k) {
        return { title: QUALITY_OPTIONS[k], value: k, selected: k === current };
      }), function (item) {
        Lampa.Storage.set(PREFIX + 'quality', item.value);
        redrawFn();
      });
    }

    function topButtons(extra, redrawFn) {
      var buttons = [];
      if (st.info.translators.length > 1) buttons.push(btn('🔊 ' + st.translator.title, pickTranslator));
      if (extra) buttons = buttons.concat(extra);
      buttons.push(btn('Качество: ' + (QUALITY_SHORT[String(cfg('quality', 'max') || 'max')] || 'Макс.'), function () {
        pickQuality(redrawFn);
      }));
      if (st.results.length > 1) buttons.push(btn('Другой результат', drawResults));
      return row(buttons);
    }

    // фильм: одна строка «Смотреть» с прогрессом
    function drawMovie() {
      var p = progressOf();
      var el = itemEl('▶', 'Смотреть', '', function () {
        playMovie(st.page, st.info, st.translator, title);
      });
      el.addClass('loki-item--primary');
      var blocks = [hero(), el, topButtons(null, drawMovie)];
      redraw(blocks, el);
      progressRows.push({ el: el, num: '▶' });
      applyProgress(el, p, '▶');
      if (p.percent > 0 && p.percent < 90) el.find('.loki-item__title').text('Продолжить');
    }

    // сериал
    function loadEpisodes() {
      loader(true);
      ajax('/ajax/get_cdn_series/?t=' + Date.now(), {
        id: st.info.id, translator_id: st.translator.id, favs: st.info.favs, action: 'get_episodes'
      }, st.page.url, function (json) {
        st.eps = parseEpisodes(json.episodes);
        if (!st.eps.order.length) return onError('список серий пуст');
        var saved = memGet('seasons')[st.info.id];
        st.season = st.eps.seasons[saved] ? saved : null;
        if (!st.season) st.season = guessSeason();
        drawEpisodes();
      }, onError);
    }

    /** сезон, в котором смотрели последним; иначе первый */
    function guessSeason() {
      for (var i = st.eps.order.length - 1; i >= 0; i--) {
        var s = st.eps.order[i];
        var list = st.eps.seasons[s];
        for (var j = 0; j < list.length; j++) {
          if (progressOf(list[j].season, list[j].episode).percent > 0) return s;
        }
      }
      return st.eps.order[0];
    }

    function pickSeason() {
      select('Сезон', st.eps.order.map(function (s) {
        return { title: 'Сезон ' + s, season: s, selected: s === st.season };
      }), function (item) {
        st.season = item.season;
        var all = memGet('seasons');
        all[st.info.id] = item.season;
        memSet('seasons', all);
        drawEpisodes();
      });
    }

    function drawEpisodes() {
      var list = st.eps.seasons[st.season];
      var seasonBtn = st.eps.order.length > 1 ? [btn('Сезон ' + st.season + ' ▾', pickSeason)] : [];
      var n = list.length, n10 = n % 10, n100 = n % 100;
      var word = n10 === 1 && n100 !== 11 ? 'серия' : n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20) ? 'серии' : 'серий';
      var grid = $('<div class="loki-eps"></div>');
      var blocks = [hero(n + ' ' + word), topButtons(seasonBtn, drawEpisodes), grid];
      var focusEl = null;
      var lastWatched = -1;
      var els = [];

      for (var i = 0; i < list.length; i++) {
        (function (e, idx) {
          var el = epCard(e, function () { playEpisode(list, idx); });
          els.push(el);
          grid.append(el);
          var p = progressOf(e.season, e.episode);
          if (p.percent > 0) lastWatched = idx;
        })(list[i], i);
      }

      // фокус: на недосмотренную серию или следующую за досмотренной
      if (lastWatched >= 0) {
        var lp = progressOf(list[lastWatched].season, list[lastWatched].episode);
        var target = lp.percent >= 90 ? Math.min(lastWatched + 1, list.length - 1) : lastWatched;
        focusEl = els[target];
      } else {
        focusEl = els[0];
      }

      redraw(blocks, focusEl);
      for (var k = 0; k < list.length; k++) {
        progressRows.push({ el: els[k], season: list[k].season, episode: list[k].episode, num: list[k].episode });
      }
      refreshProgress();

      // кадры и названия серий из TMDB (если фильм открыт с карточки Lampa)
      var season = st.season;
      tmdbSeason(movie, season, function (tmdbEps) {
        if (season !== st.season || !tmdbEps.length) return;
        for (var a = 0; a < list.length; a++) {
          for (var b = 0; b < tmdbEps.length; b++) {
            var t = tmdbEps[b];
            if (String(t.episode_number) !== String(list[a].episode)) continue;
            if (t.still_path) els[a].find('.loki-ep__img').css('background-image', 'url("' + tmdbImg(t.still_path, 'w300') + '")').addClass('loki-ep__img--still');
            if (t.name && !/^(Эпизод|Episode|Серия)\s*\d+$/i.test(t.name)) els[a].find('.loki-item__title').text(list[a].episode + '. ' + t.name);
            break;
          }
        }
      });
    }

    /** карточка серии: кадр (или номер), отметка ✓, полоска прогресса; классы loki-item__* — для applyProgress */
    function epCard(e, onEnter) {
      var el = $('<div class="loki-ep selector"><div class="loki-ep__img">' +
        '<div class="loki-item__num"></div><div class="loki-item__bar" style="display:none"><div></div></div></div>' +
        '<div class="loki-item__title"></div><div class="loki-item__meta"></div></div>');
      el.find('.loki-item__num').text(e.episode);
      el.find('.loki-item__title').text(e.title);
      return focusable(el, onEnter);
    }

    function playEpisode(list, idx) {
      var e = list[idx];
      loader(true);
      getStream(st.page, st.info, st.translator, e, function (encoded) {
        loader(false);
        play(title + ' — S' + e.season + 'E' + e.episode, encoded, {
          season: e.season,
          episode: e.episode,
          ctx: { page: st.page, info: st.info, translator: st.translator, movieTitle: title, ep: e },
          onStart: function (video) {
            startSession(st.page, st.info, st.translator, list, idx, title, video);
          }
        });
      }, function (err) {
        loader(false);
        noty(err);
      });
    }
  }

  // ---------- «Loki поиск»: поиск прямо по сайту (пункт в боковом меню) ----------

  function LokiSearch(object) {
    var self = this;
    var scroll = new Lampa.Scroll({ mask: true, over: true });
    var root = $('<div class="loki-screen-wrap"></div>');
    var body = $('<div class="loki-screen"></div>');
    var last = null;
    var asked = false;
    var st = { query: object.query || '', page: 1, items: [], hasNext: false, error: '' };

    this.create = function () {
      injectCss();
      scroll.minus();
      root.append(scroll.render());
      scroll.append(body);
      draw();
      return this.render();
    };

    this.render = function () { return root; };

    this.start = function () {
      try {
        if (Lampa.Activity.active().activity !== this.activity) return;
      } catch (e) {}
      Lampa.Controller.add('content', {
        toggle: function () {
          Lampa.Controller.collectionSet(scroll.render());
          Lampa.Controller.collectionFocus(last || false, scroll.render());
        },
        up: function () {
          if (Navigator.canmove('up')) Navigator.move('up');
          else if (!jumpRow(scroll.render(), last, 'up')) Lampa.Controller.toggle('head');
        },
        down: function () {
          if (Navigator.canmove('down')) Navigator.move('down');
          else jumpRow(scroll.render(), last, 'down');
        },
        left: function () {
          if (Navigator.canmove('left')) Navigator.move('left');
          else Lampa.Controller.toggle('menu');
        },
        right: function () { Navigator.move('right'); },
        back: function () { Lampa.Activity.backward(); }
      });
      Lampa.Controller.toggle('content');
      // при первом открытии сразу показываем клавиатуру
      if (!asked) {
        asked = true;
        if (st.query) load();   // пришли из «Ещё» в поиске Lampa — сразу показываем результаты
        else askQuery();
      }
    };

    this.pause = function () {};
    this.stop = function () {};
    this.destroy = function () {
      try { scroll.destroy(); } catch (e) {}
      root.remove();
    };

    function loader(on) { try { self.activity.loader(on); } catch (e) {} }

    function focusable(el, onEnter) {
      el.on('hover:focus', function () { last = el[0]; scroll.update(el, true); });
      el.on('hover:enter', onEnter);
      return el;
    }

    function toggle() {
      try { self.activity.toggle(); } catch (e) { Lampa.Controller.toggle('content'); }
    }

    function askQuery() {
      if (!Lampa.Input || !Lampa.Input.edit) return noty('в этой версии Lampa нет экранной клавиатуры');
      Lampa.Input.edit({ title: 'Loki поиск', value: st.query, free: true, nosave: true }, function (value) {
        value = String(value || '').trim();
        if (value && value !== st.query) {
          st.query = value;
          st.page = 1;
          st.items = [];
          st.hasNext = false;
          load();
        } else toggle();
      });
    }

    function load() {
      if (!host()) {
        st.error = 'укажите адрес сайта: Настройки → Loki → Зеркало';
        return draw();
      }
      loader(true);
      var path = '/search/?do=search&subaction=search&q=' + encodeURIComponent(st.query) + (st.page > 1 ? '&page=' + st.page : '');
      var firstNew = st.items.length;
      getPage(path, function (html) {
        loader(false);
        var res = parseFullSearch(html);
        st.items = st.items.concat(res.items);
        st.hasNext = res.hasNext && res.items.length > 0;
        st.error = '';
        draw(firstNew);
      }, function (err) {
        loader(false);
        st.error = err;
        draw();
      });
    }

    function open(r) { openSitePage(r); }

    /** focusIndex — на какой результат поставить фокус (после «Показать ещё» — на первый новый) */
    function draw(focusIndex) {
      body.empty();
      var head = $('<div><div class="loki-screen__head">Loki поиск</div></div>');
      var sub = st.error ? 'Ошибка: ' + st.error
        : st.query ? (st.items.length ? 'Найдено: ' + st.items.length + (st.hasNext ? '+' : '') : 'Ничего не найдено')
        : 'Поиск по сайту из настроек Loki';
      head.append($('<div class="loki-screen__sub"></div>').text(sub));
      body.append(head);

      var qbtn = $('<div class="loki-searchbar selector">' + SEARCH_SVG + '<span></span></div>');
      qbtn.find('span').text(st.query || 'Введите название');
      if (!st.query) qbtn.addClass('loki-searchbar--empty');
      focusable(qbtn, askQuery);
      body.append(qbtn);

      var grid = $('<div class="loki-grid"></div>');
      var focusEl = qbtn;
      st.items.forEach(function (r, i) {
        var el = $('<div class="loki-card selector"><div class="loki-card__img"></div>' +
          '<div class="loki-card__title"></div><div class="loki-card__meta"></div></div>');
        if (r.poster) el.find('.loki-card__img').css('background-image', 'url("' + r.poster + '")');
        if (r.type) el.find('.loki-card__img').append($('<div class="loki-card__type"></div>').text(r.type));
        el.find('.loki-card__title').text(r.title);
        // «2024, США, Фантастика» → «2024 · Фантастика»
        var parts = String(r.info || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        el.find('.loki-card__meta').text(parts.length > 2 ? parts[0] + ' · ' + parts[parts.length - 1] : parts.join(' · '));
        focusable(el, function () { open(r); });
        grid.append(el);
        if (i === focusIndex || (focusIndex === undefined && i === 0)) focusEl = el;
      });

      if (st.hasNext) {
        grid.append(focusable($('<div class="loki-card loki-card--more selector"><div class="loki-card__img">Ещё →</div>' +
          '<div class="loki-card__title">Показать ещё</div></div>'), function () {
          st.page++;
          load();
        }));
      }
      if (st.items.length) body.append(grid);

      last = focusEl[0];
      try { Lampa.Layer.update(root[0]); } catch (e) {}
      toggle();
    }
  }

  var SEARCH_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>';

  /** экран с сеткой результатов и подгрузкой страниц (также запасной вариант для старых версий Lampa) */
  function openSearchScreen(query) {
    Lampa.Activity.push({ url: '', title: 'Loki поиск', component: 'player_by_loki_search', query: query || '', page: 1 });
  }

  function openSitePage(r) {
    Lampa.Activity.push({
      url: '',
      title: 'Loki',
      component: 'player_by_loki_screen',
      movie: { title: r.title },
      sitePage: { url: r.url, title: r.title, info: r.info },
      page: 1
    });
  }

  /**
   * Источник для родного поиска Lampa (тот же экран, что по лупе: клавиатура, история, карточки).
   * История запросов — общая с поиском Lampa, сохраняется при выборе результата.
   */
  var searchGen = 0;
  var LOKI_SOURCE = {
    title: 'Loki',
    params: { lazy: true, nofound: 'Ничего не найдено', start_typing: 'Введите название фильма или сериала' },
    search: function (params, oncomplite) {
      var gen = ++searchGen;
      var query = params.query;
      try { query = decodeURIComponent(query); } catch (e) {}
      if (!host()) {
        noty('укажите адрес сайта: Настройки → Loki → Зеркало');
        return oncomplite([]);
      }
      getPage('/search/?do=search&subaction=search&q=' + encodeURIComponent(query), function (html) {
        if (gen !== searchGen) return;
        var res = parseFullSearch(html);
        oncomplite(res.items.length ? [{
          title: 'Loki',
          results: res.items.map(function (r, i) {
            var year = (/^(\d{4})/.exec(r.info || '') || [])[1] || '';
            return { id: 'loki_' + i + '_' + r.url.length, title: r.title, original_title: '', poster: r.poster, img: r.poster, release_date: year, loki: r };
          })
        }] : []);
      }, function (err) {
        if (gen !== searchGen) return;
        noty(err);
        oncomplite([]);
      });
    },
    onCancel: function () { searchGen++; },
    onSelect: function (params, close) {
      var r = params.element && params.element.loki;
      close();   // закрывает поиск и сохраняет запрос в историю
      if (r) openSitePage(r);
    },
    onMore: function (params, close) {
      var q = params.query;
      try { q = decodeURIComponent(q); } catch (e) {}
      close();
      openSearchScreen(q);
    }
  };

  function openSearch() {
    if (Lampa.Search && Lampa.Search.open) {
      try { return Lampa.Search.open({ sources: [LOKI_SOURCE] }); } catch (e) { log('native search error', e); }
    }
    openSearchScreen('');
  }

  /** пункт «Loki поиск» в боковом меню Lampa (после встроенного «Поиска», иначе после первого пункта) */
  function addMenuItem() {
    try {
      var list = $('.menu .menu__list').first();
      if (!list.length || list.find('.loki-menu-search').length) return;
      var item = $('<li class="menu__item selector loki-menu-search"><div class="menu__ico">' + SEARCH_SVG + '</div><div class="menu__text">Loki поиск</div></li>');
      item.on('hover:enter', openSearch);
      var anchor = list.find('[data-action="search"]').first();
      if (!anchor.length) anchor = list.children('.menu__item').first();
      if (anchor.length) anchor.after(item);
      else list.append(item);
    } catch (e) { log('menu item error', e); }
  }

  function openScreen(movie) {
    Lampa.Activity.push({
      url: '',
      title: 'Loki',
      component: 'player_by_loki_screen',
      movie: movie,
      page: 1
    });
  }

  // ---------- интеграция в Lampa ----------

  var ICON = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';

  /** в списке настроек показываем пароль звёздочками (одинаковой длины, чтобы не выдавать её) */
  function maskPassword(item) {
    if (!cfg('password')) return; // пусто — Lampa покажет подсказку
    item.find('.settings-param__value').text('••••••••');
  }

  function addSettings() {
    Lampa.SettingsApi.addComponent({ component: 'player_by_loki', name: 'Loki', icon: ICON });

    Lampa.SettingsApi.addParam({
      component: 'player_by_loki',
      param: { name: PREFIX + 'host', type: 'input', values: '', default: '', placeholder: 'не указано' },
      field: { name: 'Зеркало', description: 'Адрес сайта, через который вы входите в свой аккаунт' }
    });
    Lampa.SettingsApi.addParam({
      component: 'player_by_loki',
      param: { name: PREFIX + 'login', type: 'input', values: '', default: '' },
      field: { name: 'Email', description: 'Логин от сайта' }
    });
    Lampa.SettingsApi.addParam({
      component: 'player_by_loki',
      param: { name: PREFIX + 'password', type: 'input', values: '', default: '', password: true },
      field: { name: 'Пароль', description: 'Хранится только на этом устройстве' },
      // Lampa сама пишет значение в строку после onRender и после ввода — маскируем поверх
      onRender: function (item) { setTimeout(function () { maskPassword(item); }, 0); },
      onChange: function () {
        $('.settings-param[data-name="' + PREFIX + 'password"]').each(function () { maskPassword($(this)); });
      }
    });
    Lampa.SettingsApi.addParam({
      component: 'player_by_loki',
      param: { name: PREFIX + 'ui', type: 'select', default: 'screen', values: { screen: 'Экран со списком серий', select: 'Всплывающие окна (старый)' } },
      field: { name: 'Интерфейс', description: 'Как показывать озвучки и серии' }
    });
    Lampa.SettingsApi.addParam({
      component: 'player_by_loki',
      param: {
        name: PREFIX + 'quality', type: 'select', default: 'max',
        values: QUALITY_OPTIONS
      },
      field: { name: 'Качество', description: 'Переключить можно и в самом плеере' }
    });
    Lampa.SettingsApi.addParam({
      component: 'player_by_loki',
      param: { name: PREFIX + 'prefer_hls', type: 'trigger', default: false },
      field: { name: 'Предпочитать HLS (m3u8)', description: 'По умолчанию берётся mp4' }
    });
  }

  function addButton(e) {
    var render = e.object.activity.render();
    var open = function () {
      if (cfg('ui', 'screen') === 'select') start(e.data.movie);
      else openScreen(e.data.movie);
    };
    var make = function (cls) {
      var b = $('<div class="full-start__button selector ' + cls + '">' + ICON + '<span>Loki</span></div>');
      b.on('hover:enter', open);
      return b;
    };

    // в окне «Смотреть» (там Lampa собирает источники)
    if (!render.find('.player-by-loki--button').length) {
      var anchor = render.find('.view--torrent');
      if (anchor.length) anchor.after(make('player-by-loki--button'));
      else render.find('.full-start-new__buttons, .full-start__buttons').first().append(make('player-by-loki--button'));
    }

    // и сразу на карточке, рядом с «Смотреть» — чтобы не открывать лишнее окно
    var play = render.find('.full-start-new__buttons .button--play').first();
    if (play.length && !render.find('.player-by-loki--main').length) play.after(make('player-by-loki--main'));
  }

  function init() {
    addSettings();
    Lampa.Component.add('player_by_loki_screen', LokiScreen);
    Lampa.Component.add('player_by_loki_search', LokiSearch);
    addMenuItem();
    try {
      Lampa.Player.listener.follow('start', onPlayerStart);
      Lampa.Player.listener.follow('start', addPlayerBackButton);
      Lampa.Player.listener.follow('ready', addPlayerBackButton);
      Lampa.Player.listener.follow('start', addPlayerVoiceButton);
      Lampa.Player.listener.follow('destroy', onPlayerDestroy);
      Lampa.Player.listener.follow('destroy', function () { playerClosedAt = Date.now(); });
    } catch (err) { log('player listener unavailable', err); }
    Lampa.Listener.follow('full', function (e) {
      if (e.type === 'complite') {
        try { addButton(e); } catch (err) { log('button error', err); }
      }
    });
    addRestartButton();
    // другие плагины могут перестраивать шапку позже — проверим ещё раз
    setTimeout(addRestartButton, 3000);
    log('loaded');
  }

  if (window.appready) init();
  else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') init(); });
})();
