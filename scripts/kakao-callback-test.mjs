/**
 * 카카오 AI 챗봇 콜백 테스트 서버
 *
 * 카카오 오픈빌더 스킬 서버 역할을 하는 최소 구현.
 * useCallback: true 즉시 반환 → callbackUrl로 비동기 응답 전달.
 * 포트 3211 (메인 서버 3210과 충돌 방지).
 *
 * 사용법:
 *   node scripts/kakao-callback-test.mjs
 *   cloudflared tunnel --url http://localhost:3211
 */

import { createServer } from 'node:http';

const PORT = 3211;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function log(tag, msg, data) {
  const ts = new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${ts}] [${tag}] ${msg}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

/** callbackUrl로 실제 응답 전달 (비동기) */
async function sendCallback(callbackUrl, utterance) {
  const echoText = `[에코] "${utterance}"\n\n콜백 응답 성공! 카카오 AI 챗봇 콜백이 정상 동작합니다.`;

  const payload = {
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text: echoText } }],
    },
  };

  log('CALLBACK', `→ POST ${callbackUrl}`);
  log('CALLBACK', '→ payload', payload);

  try {
    const resp = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await resp.json().catch(() => resp.text());
    log('CALLBACK', `← ${resp.status}`, result);

    if (result?.status === 'SUCCESS') {
      log('SUCCESS', '콜백 응답 전달 성공!');
    } else {
      log('WARN', '콜백 응답 결과 확인 필요', result);
    }
  } catch (err) {
    log('ERROR', `콜백 전송 실패: ${err.message}`);
  }
}

const server = createServer(async (req, res) => {
  // health check
  if (req.method === 'GET' && req.url === '/') {
    return json(res, 200, {
      status: 'ok',
      service: 'kakao-callback-test',
      timestamp: new Date().toISOString(),
    });
  }

  // 카카오 스킬 엔드포인트
  if (req.method === 'POST' && req.url === '/kakao/skill') {
    const body = await parseBody(req);

    if (!body) {
      return json(res, 400, { error: 'invalid JSON' });
    }

    const utterance = body?.userRequest?.utterance ?? '(발화 없음)';
    const callbackUrl = body?.userRequest?.callbackUrl;
    const userId = body?.userRequest?.user?.id ?? 'unknown';
    const botId = body?.bot?.id ?? 'unknown';

    log('SKILL', `수신 — user:${userId} bot:${botId}`);
    log('SKILL', `발화: "${utterance}"`);
    log('SKILL', `callbackUrl: ${callbackUrl ?? '없음'}`);

    // callbackUrl이 있으면 → 콜백 모드
    if (callbackUrl) {
      log('SKILL', '→ useCallback: true 즉시 반환, 3초 후 콜백 전송');

      // 3초 딜레이로 비동기 콜백 (LLM 처리 시뮬레이션)
      setTimeout(() => sendCallback(callbackUrl, utterance), 3000);

      return json(res, 200, {
        version: '2.0',
        useCallback: true,
        data: {
          text: '잠시만 기다려주세요, 답변을 준비하고 있어요...',
        },
      });
    }

    // callbackUrl 없으면 → 동기 응답 (5초 이내)
    log('SKILL', '→ 동기 응답 (콜백 URL 없음)');
    return json(res, 200, {
      version: '2.0',
      template: {
        outputs: [
          {
            simpleText: {
              text: `[에코] "${utterance}"\n\n동기 응답 모드 (콜백 비활성화 블록)`,
            },
          },
        ],
      },
    });
  }

  // 404
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  log('SERVER', `카카오 콜백 테스트 서버 시작 — http://localhost:${PORT}`);
  log('SERVER', '엔드포인트:');
  log('SERVER', `  GET  /             — 헬스 체크`);
  log('SERVER', `  POST /kakao/skill  — 카카오 스킬 서버`);
  log('SERVER', '');
  log('SERVER', '다음 단계: cloudflared tunnel --url http://localhost:3211');
  log('SERVER', '생성된 URL을 카카오 오픈빌더 스킬에 등록하세요.');
  log('SERVER', '  예: https://xxxx.trycloudflare.com/kakao/skill');
});
