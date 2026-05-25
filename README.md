# tidymac

macOS 개발 워크플로를 위한 시스템 리소스 스캔 및 정리 CLI입니다. React Native 개발 중 자주 쌓이는 Metro, Watchman, Xcode, Simulator, package manager, Docker, 개발 포트 점유 상태를 스캔하고 선택적으로 정리합니다.

## 요구사항

- macOS
- Node.js 20+
- pnpm 9

## 설치 및 빌드

```bash
pnpm install
pnpm typecheck
pnpm build
node dist/cli.js --help
```

## 명령어

```bash
tidymac scan [--category <cat>]
tidymac clean [--category <cat>] [--dry-run] [--force]
tidymac doctor [--watch] [--interval <초>]
tidymac history [--limit <n>]
```

카테고리는 `memory`, `disk`, `cpu`, `network`를 지원합니다.

`doctor --watch`는 터미널 한쪽에 띄워두고 시스템 상태를 주기적으로 갱신할 때 사용합니다.

```bash
tidymac doctor --watch
tidymac doctor --watch --interval 10
tidymac doctor --interval 3
```

## 안전 모델

- macOS가 아니면 CLI 진입 시 즉시 종료합니다.
- 삭제 가능한 경로는 홈 디렉터리, `/private/var/folders`, `/tmp`, `/var/tmp` 계열로 제한합니다.
- `/System`, `/Library`, `/usr`, `/bin`, `/sbin`, `/etc` 하위 경로는 차단합니다.
- 캐시 정리는 디렉터리 자체를 삭제하지 않고 내용만 비웁니다.
- 모든 정리 항목은 `execute({ dryRun })`을 구현하며, dry-run도 실행 이력에 기록됩니다.
- `caution`, `danger` 항목은 실제 실행 전에 추가 확인을 요구합니다.
- `--force`는 `safe` 항목만 자동 선택합니다.

## 도메인 구조

각 카테고리는 CLI와 독립적으로 동작합니다.

```ts
import { scanDisk } from "./src/categories/disk.js";

const result = await scanDisk();
for (const item of result.items) {
  await item.execute({ dryRun: true });
}
```

공통 모델은 `src/lib/types.ts`에 있고, 각 카테고리 파일은 `scan<Category>(): Promise<ScanResult>`만 export합니다.

## 정리 대상

| 카테고리 | 항목 |
|---|---|
| memory | inactive memory purge, Metro/Watchman/Simulator/qemu 잔존 프로세스 |
| disk | `~/Library/Caches`, Xcode DerivedData, CoreSimulator 캐시, Xcode Archives, npm/pnpm/yarn 캐시, Gradle, `~/Library/Logs`, Homebrew cleanup, Docker prune, Metro 임시 캐시 |
| cpu | 좀비 프로세스, CPU 50% 이상 점유 프로세스 상위 5개 |
| network | DNS flush, 개발 포트 점유 프로세스 |

## 이력

모든 실행 결과는 dry-run 포함 `~/.tidymac/history.json`에 기록됩니다. 최근 1000개만 보존합니다.

```bash
tidymac history --limit 50
```
