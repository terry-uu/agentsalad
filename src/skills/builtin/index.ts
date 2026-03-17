/**
 * Builtin Skills Registry — 모든 빌트인 스킬 등록 (10개)
 *
 * 각 스킬 모듈에서 BuiltinSkill 구현을 가져와 단일 배열로 export.
 * resolveSkills()에서 에이전트의 토글에 따라 활성화.
 * file(3) + web(2) + system(1) + google(3) + cron(1).
 */
import type { BuiltinSkill } from '../types.js';

import { fileReadSkill } from './file-read.js';
import { fileWriteSkill } from './file-write.js';
import { fileListSkill } from './file-list.js';
import { webFetchSkill } from './web-fetch.js';
import { webBrowseSkill } from './web-browse.js';
import { bashSkill } from './bash.js';
import { googleGmailSkill } from './google/gmail.js';
import { googleCalendarSkill } from './google/calendar.js';
import { googleDriveSkill } from './google/drive.js';
import { cronSkill } from './cron.js';

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  fileReadSkill,
  fileWriteSkill,
  fileListSkill,
  webFetchSkill,
  webBrowseSkill,
  bashSkill,
  googleGmailSkill,
  googleCalendarSkill,
  googleDriveSkill,
  cronSkill,
];
