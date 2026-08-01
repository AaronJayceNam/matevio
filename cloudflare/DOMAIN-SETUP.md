# matevio.com을 Cloudflare에 등록하기 (가비아 → Cloudflare 네임서버 이전)

> 이 작업은 **사장님 계정**(Cloudflare / 가비아 / Render)에서만 가능합니다.
> 아래는 현재 실제 설정을 조회해서 맞춘 단계입니다.

## 현재 상태 (조회 결과)

| 항목 | 값 |
|---|---|
| 등록기관 | **가비아** (네임서버 `ns.gabia.net`, `ns1.gabia.co.kr`, `ns.gabia.co.kr`) |
| `matevio.com` | A → **216.24.57.1** (Render) |
| `www.matevio.com` | A → **216.24.57.7** (Render) |
| MX(메일) | **없음** → 이전해도 깨질 이메일 없음 ✅ |
| TXT | 없음 |
| Render 서비스 | `matevio-chess` (Docker, free plan) |

옮길 레코드가 A 2개뿐이라 이전 위험이 매우 낮습니다.

---

## 1단계 — Cloudflare에 사이트 추가

1. [dash.cloudflare.com](https://dash.cloudflare.com) 로그인 → **Add a site**
2. `matevio.com` 입력 → **Free 플랜** 선택 → Continue
3. Cloudflare가 기존 레코드를 자동 스캔합니다. **아래 2개가 있는지 확인**하고,
   없으면 직접 추가하세요:

   | Type | Name | Content | Proxy |
   |---|---|---|---|
   | A | `matevio.com` (또는 `@`) | `216.24.57.1` | **주황 구름 ON** |
   | A | `www` | `216.24.57.7` | **주황 구름 ON** |

   > 주황 구름(Proxied)이 켜져 있어야 Cloudflare 캐시·속도 혜택을 받습니다.

4. Cloudflare가 배정해 준 **네임서버 2개**를 메모합니다
   (예: `xxx.ns.cloudflare.com`, `yyy.ns.cloudflare.com`)

## 2단계 — 가비아에서 네임서버 변경

1. [가비아](https://www.gabia.com) 로그인 → **My가비아 → 도메인 → matevio.com → 관리**
2. **네임서버 설정**(도메인 정보 변경 → 네임서버)
3. 기존 `ns.gabia.net` 등을 **Cloudflare가 준 네임서버 2개로 교체** → 저장
4. 반영까지 보통 10분~수 시간 (최대 24시간)

## 3단계 — Cloudflare 권장 설정 (사이트 활성화 후)

- **SSL/TLS → Overview → `Full (strict)`** 선택
  (Render가 유효한 인증서를 주므로 strict가 맞습니다. Flexible은 무한 리디렉션을 유발할 수 있어 피하세요.)
- **SSL/TLS → Edge Certificates → Always Use HTTPS: ON**
- **Speed → Optimization**: Auto Minify는 **끄는 걸 권장** (앱이 이미 버전드 자산 + brotli 사용 중)
- **Network → WebSockets: ON** (온라인 대국 `/ws`, `/wsc`에 필요 — 기본 켜져 있음)
- **Caching → Configuration → Browser Cache TTL: `Respect Existing Headers`**
  (서버가 이미 `immutable` 헤더를 보냅니다. 이걸 덮어쓰면 배포 후 갱신이 늦어져요.)

## 4단계 — Render 쪽 확인

Render → `matevio-chess` → **Settings → Custom Domains** 에 `matevio.com`,
`www.matevio.com`이 이미 등록되어 있어야 합니다(현재 A레코드가 Render를 가리키므로
등록돼 있을 가능성이 높습니다). 없다면 추가하세요.

## 5단계 — 검증

네임서버 반영 후:

```bash
nslookup -type=NS matevio.com 8.8.8.8
```
→ `*.ns.cloudflare.com`이 나오면 이전 완료.

```bash
curl -sI https://matevio.com/ | grep -iE "server|cf-ray"
```
→ `server: cloudflare` / `cf-ray:` 헤더가 보이면 Cloudflare를 타고 있는 것.

앱이 정상인지: 사이트 접속 → 온라인 대국 탭에서 매칭이 되면 WebSocket도 정상.

---

## 그 다음: "서버 깨우는 중" 없애기

도메인 등록이 끝나면 같은 폴더의 **`README.md`** 대로 **Keep-alive Worker**를
배포하세요 (5분마다 `/api/health` 핑 → Render가 잠들지 않음 → 깨우는 중 메시지 소멸).

## 주의

- 네임서버를 옮기면 **그 도메인의 모든 DNS를 Cloudflare가 관리**합니다. 현재 MX가
  없어 메일 영향은 없지만, 나중에 이 도메인으로 메일을 받으려면 MX를 Cloudflare에
  추가해야 합니다.
- 무료 Render 인스턴스는 월 750시간. Keep-alive로 24시간 깨워두면 ≈730시간이라
  이 서비스 하나면 괜찮지만, 다른 서비스도 있으면 합산을 확인하세요.
