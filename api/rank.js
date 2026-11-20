// 네이버 플레이스 순위 조회 (외부 API 키 없이 네이버 모바일 플레이스 직접 조회)
// - 서버(Vercel 함수)에서만 네이버를 호출하고, 브라우저에는 결과만 돌려줍니다.
// - 환경변수: APP_ACCESS_CODE (관리자 접속 코드) 만 필요합니다.
const crypto = require('node:crypto');

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const SEOUL_X = '126.9780';
const SEOUL_Y = '37.5665';

const json = (res, status, data) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(data);
};
const safeEqual = (a, b) => {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length > 0 && A.length === B.length && crypto.timingSafeEqual(A, B);
};
const valid = (v, max) => typeof v === 'string' && !!v.trim() && v.trim().length <= max;
const str = v => (v === null || v === undefined ? '' : String(v));
// 네이버는 리뷰 수를 "2,492" 같은 문자열로 주기도 해서 숫자로 정규화합니다.
const safeNumber = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const n = Number(v.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && v.trim() !== '' ? n : null;
};

// ---------- 네이버 호출 ----------
async function naverHtml(url, timeout = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': MOBILE_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        Referer: 'https://m.naver.com/',
      },
      signal: ctrl.signal,
      redirect: 'follow',
      cache: 'no-store',
    });
    if (!r.ok) {
      const error = new Error(
        r.status === 403 || r.status === 429
          ? `네이버가 조회를 일시 차단했습니다 (${r.status}). 잠시 뒤 다시 시도해 주세요.`
          : `네이버 응답 오류 (${r.status})`
      );
      error.status = r.status === 403 || r.status === 429 ? 429 : 502;
      error.blocked = r.status === 403 || r.status === 429;
      throw error;
    }
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

// HTML 안의 window.__APOLLO_STATE__ = {...}; 객체를 중괄호 짝을 세어 안전하게 추출합니다.
function apolloState(html) {
  const marker = 'window.__APOLLO_STATE__';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const eq = html.indexOf('=', at + marker.length);
  if (eq < 0) return null;
  const start = html.indexOf('{', eq);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const raw = html.slice(start, i + 1);
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function rootQueryValue(state, prefix) {
  const root = state && state.ROOT_QUERY;
  if (!root || typeof root !== 'object') return null;
  const key = Object.keys(root).find(k => k.startsWith(prefix));
  return key ? root[key] : null;
}

// 광고(adBusinesses)는 제외하고, 유기적 검색 결과만 순서대로 뽑아냅니다. (최대 100개)
function organicBusinesses(state) {
  if (!state) return [];
  const ads = new Set();
  const root = state.ROOT_QUERY || {};
  for (const key of Object.keys(root)) {
    if (!key.startsWith('adBusinesses(')) continue;
    const items = root[key] && root[key].items;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (it && it.__ref) ads.add(it.__ref);
      if (it && it.id) ads.add(`PlaceListBusinessesItem:${it.id}`);
    }
  }
  let refs = [];
  const list = rootQueryValue(state, 'placeList(');
  const items = list && list.businesses && Array.isArray(list.businesses.items) ? list.businesses.items : [];
  refs = items.map(it => (it && it.__ref) || (it && it.id ? `PlaceListBusinessesItem:${it.id}` : '')).filter(Boolean);
  if (!refs.length) {
    refs = Object.keys(state).filter(k => k.startsWith('PlaceListBusinessesItem:'));
  }
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    if (ads.has(ref)) continue;
    const it = state[ref];
    if (!it || !it.id || seen.has(String(it.id))) continue;
    if (it.adId || it.isAd || it.ad) continue; // 광고 표시가 붙은 항목 제외
    seen.add(String(it.id));
    out.push(it);
    if (out.length >= 100) break;
  }
  return out;
}

const norm = v => str(v).replace(/\s+/g, '').toLowerCase();

function extractPlaceId(input) {
  const s = str(input).trim();
  if (/^\d{4,20}$/.test(s)) return s;
  const m = s.match(/place\/(\d{4,20})/);
  if (m) return m[1];
  const q = s.match(/[?&]place(?:Id|_id)?=(\d{4,20})/);
  if (q) return q[1];
  const digits = s.match(/^https?:\/\/\S*?\/(\d{4,20})(?:[/?#]|$)/);
  if (digits) return digits[1];
  return '';
}

function toListItem(it) {
  return {
    place_id: str(it.id),
    name: str(it.name || it.normalizedName),
    category: str(it.category),
    address: str(it.fullAddress || it.roadAddress || it.address || it.commonAddress),
    visitor_reviews: safeNumber(it.visitorReviewCount),
    blog_reviews: safeNumber(it.blogCafeReviewCount),
    _norm: norm(it.normalizedName || it.name),
  };
}

async function searchBusinesses(keyword) {
  const url =
    'https://m.place.naver.com/place/list?query=' +
    encodeURIComponent(keyword) +
    `&x=${SEOUL_X}&y=${SEOUL_Y}&display=100&start=1`;
  const html = await naverHtml(url, 20000);
  const state = apolloState(html);
  if (!state) {
    const error = new Error('네이버 검색 결과를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    error.status = 502;
    throw error;
  }
  return organicBusinesses(state).map(toListItem);
}

// 같은 키워드를 연달아 조회할 때 네이버 호출을 줄이는 짧은 캐시 (함수 인스턴스 메모리).
const cache = new Map();
const CACHE_MS = 60000;
async function cachedBusinesses(keyword) {
  const key = norm(keyword);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const list = await searchBusinesses(keyword);
  if (cache.size > 40) cache.clear();
  cache.set(key, { at: Date.now(), list });
  return list;
}

async function placeDetail(placeId) {
  const url = `https://m.place.naver.com/place/${placeId}/home`;
  const html = await naverHtml(url, 22000);
  const state = apolloState(html);
  if (!state) {
    const error = new Error('네이버 플레이스 상세 정보를 읽지 못했습니다.');
    error.status = 502;
    throw error;
  }
  const key = Object.keys(state).find(k => k.startsWith(`PlaceDetailBase:${placeId}`)) ||
    Object.keys(state).find(k => k.startsWith('PlaceDetailBase:'));
  const base = key ? state[key] : null;
  if (!base) return { found: false };
  const talktalk = str(base.talktalkUrl) || (base.talktalkUrl && base.talktalkUrl.__ref ? '' : '');
  return {
    found: true,
    place: {
      place_id: str(base.id || placeId),
      name: str(base.name),
      place_url: `https://m.place.naver.com/place/${placeId}/home`,
      address: str(base.fullAddress || base.roadAddress || base.address),
      visitor_reviews: safeNumber(base.visitorReviewsTotal),
      blog_reviews: safeNumber(base.cafeBlogReviewsTotal),
      additional_info: null,
    },
    talktalk_url: talktalk || null,
  };
}

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: '지원하지 않는 요청입니다.' });
  if (!process.env.APP_ACCESS_CODE)
    return json(res, 503, { error: '서버에 APP_ACCESS_CODE 환경변수를 설정해야 합니다.' });
  if (!safeEqual(req.headers['x-app-code'], process.env.APP_ACCESS_CODE))
    return json(res, 401, { error: '관리자 접속 코드가 틀렸습니다. 순위 조회 화면의 연결 설정에서 코드를 입력해 주세요.' });

  const action = String(req.query.action || '');
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    // 서버 연결 확인용: 자동 추적 슬롯은 이 무료 직접 조회 모드에서 지원하지 않습니다.
    if (action === 'slots') {
      return json(res, 200, { slots: [], used: 0, limit: 0 });
    }
    if (action === 'check') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST로 요청해 주세요.' });
      const keyword = String(b.keyword || '').trim();
      const place = String(b.place || '').trim();
      if (!valid(keyword, 100) || !valid(place, 1000))
        return json(res, 400, { error: '키워드(100자 이내)와 플레이스명 또는 플레이스 ID/URL을 입력해 주세요.' });

      let list;
      try {
        list = await cachedBusinesses(keyword);
      } catch (e) {
        if (e.blocked) {
          return json(res, 200, {
            result: { rank: 0, found: false, blocked: true, place_id: '', place_name: place },
          });
        }
        throw e;
      }

      const wantedId = extractPlaceId(place);
      let hit = null;
      let index = -1;
      if (wantedId) {
        index = list.findIndex(it => it.place_id === wantedId);
        if (index >= 0) hit = list[index];
      }
      if (!hit) {
        const target = norm(place);
        if (target) {
          // 1) 정확히 같은 이름, 2) 서로 포함하는 이름(부분 일치). 이름이 짧으면 오매칭을 피합니다.
          index = list.findIndex(it => it._norm === target);
          if (index < 0 && target.length >= 3) {
            index = list.findIndex(it => it._norm && (it._norm.includes(target) || target.includes(it._norm)));
          }
          if (index >= 0) hit = list[index];
        }
      }

      if (hit) {
        return json(res, 200, {
          result: {
            rank: index + 1,
            found: true,
            blocked: false,
            place_id: hit.place_id,
            place_name: hit.name,
            address: hit.address,
            visitor_reviews: hit.visitor_reviews,
            blog_reviews: hit.blog_reviews,
          },
        });
      }
      return json(res, 200, {
        result: {
          rank: 300,
          found: false,
          blocked: false,
          place_id: wantedId || '',
          place_name: place,
        },
      });
    }
    if (action === 'candidates') {
      const name = String(req.query.name || '').trim();
      if (!valid(name, 100)) return json(res, 400, { error: '찾을 플레이스명을 입력해 주세요.' });
      const list = await cachedBusinesses(name);
      const candidates = list.slice(0, 30).map(it => ({
        place_id: it.place_id,
        name: it.name,
        address: it.address,
        category: it.category,
      }));
      return json(res, 200, { candidates, status: candidates.length ? 'ok' : 'not_found', has_more: false });
    }
    if (action === 'place') {
      const placeId = String(req.query.place || '').trim();
      if (!/^\d{4,20}$/.test(placeId)) return json(res, 400, { error: '숫자로 된 플레이스 ID가 필요합니다.' });
      const d = await placeDetail(placeId);
      if (!d.found) return json(res, 404, { error: '플레이스 상세 정보를 찾지 못했습니다.' });
      return json(res, 200, {
        place: d.place,
        partial: false,
        fetched_at: new Date().toISOString(),
      });
    }
    if (action === 'keyword') {
      // 네이버 검색광고 API(키 필요) 없이는 월간 검색량을 확인할 수 없습니다.
      return json(res, 200, {
        monthly_total: null,
        monthly_pc: null,
        monthly_mobile: null,
        note: '검색량은 네이버 검색광고 API 키가 있어야 확인할 수 있습니다.',
      });
    }
    if (action === 'register' || action === 'run') {
      return json(res, 501, {
        error: '무료 직접 조회 모드에서는 자동 순위 추적을 지원하지 않습니다. 화면의 순위 조회로 확인해 주세요.',
      });
    }
    return json(res, 404, { error: '없는 기능입니다.' });
  } catch (e) {
    let status = Number(e.status) || 502;
    if (status < 400 || status > 599) status = 502;
    return json(res, status, {
      error:
        e.name === 'AbortError'
          ? '네이버 조회 시간 초과. 잠시 뒤 다시 시도해 주세요.'
          : e.message || '조회 오류',
    });
  }
};
