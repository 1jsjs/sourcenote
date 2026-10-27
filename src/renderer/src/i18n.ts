import type { AppLanguage } from '../../shared/types'

/**
 * Renderer strings. Every user-visible string lives here; `ko` keeps the
 * exact existing Korean copy and `en` is natural product English. Switching
 * `language` re-renders the UI immediately; stored summaries are never
 * re-generated. `{name}` placeholders are filled by `t()`.
 */

export const messages = {
  ko: {
    appTitle: 'Sourcenote',
    close: '닫기',
    noteTitlePlaceholder: '노트 제목',
    newNote: '새 노트',
    noNotes: '노트가 없습니다',
    selectNote: '왼쪽에서 노트를 선택하거나 새로 만드세요.',
    addAudio: '오디오 파일 추가',
    addPdf: 'PDF 추가',
    makeSummary: '근거 요약 만들기',
    citedSummary: '근거 요약',
    suggestCorrections: '용어 교정 제안',
    suggestCorrectionsTitle: '전사 오류(용어·중복·오타) 수정 제안',
    summarizing: '요약 중…',
    verifying: '검증 중…',
    generatingCorrections: '교정 제안 생성 중…',
    doneLabel: '완료',
    verifiedCount: '검증됨',
    notInSources: '자료에 없음',
    suggestedFixes: '교정 제안',
    acceptedCount: '수락됨',
    rejectedCount: '거절됨',
    acceptAll: '모두 수락',
    accept: '수락',
    reject: '거절',
    kindTerm: '용어',
    kindDuplicate: '중복',
    kindTypo: '오타',
    playFromHere: '이 위치부터 재생',
    checkNotesTitle: '내 필기 검증',
    checkPlaceholder: '강의를 듣고 적은 내용을 붙여 넣으세요. 문장마다 강의 근거를 찾아 맞는지 확인합니다.',
    checkButton: '검증하기',
    checking: '검증 중…',
    noSources: '추가된 자료가 없습니다.',
    statusPending: '대기',
    statusConverting: '변환 중',
    statusTranscribing: '전사 중',
    statusDone: '완료',
    statusError: '오류',
    transcribingProgress: '전사 중 {done}/{total}',
    lengthLabel: '길이 {hms}',
    slidesLabel: '슬라이드 {count}페이지',
    correctedMark: '교정됨',
    correctedTitle: '원문: {text}',
    playerRegion: '오디오 재생',
    play: '재생',
    pause: '일시정지',
    seekLabel: '재생 위치',
    slideRegion: '슬라이드 보기',
    slideLoading: '불러오는 중…',
    slideRenderError: '슬라이드를 그릴 수 없습니다.',
    slideLoadError: '슬라이드를 불러오지 못했습니다.',
    prev: '이전',
    next: '다음',
    openSample: '샘플 노트 열기',
    sampleLanguageKo: '한국어',
    sampleLanguageEn: 'English',
    emptyTitle: 'Sourcenote는 강의 녹음과 슬라이드에서 근거 있는 요약 노트를 만듭니다.',
    emptyHint: 'API 키 없이 샘플 노트로 바로 살펴보세요.',
    importing: '가져오는 중…',
    noSamples: '사용 가능한 샘플이 없습니다.',
  },
  en: {
    appTitle: 'Sourcenote',
    close: 'Close',
    noteTitlePlaceholder: 'Note title',
    newNote: 'New note',
    noNotes: 'No notes yet',
    selectNote: 'Select a note on the left, or create a new one.',
    addAudio: 'Add audio',
    addPdf: 'Add PDF',
    makeSummary: 'Make cited summary',
    citedSummary: 'Cited summary',
    suggestCorrections: 'Suggest term fixes',
    suggestCorrectionsTitle: 'Suggest fixes for transcription errors (terms, repeats, typos)',
    summarizing: 'Summarizing…',
    verifying: 'Verifying…',
    generatingCorrections: 'Suggesting fixes…',
    doneLabel: 'Done',
    verifiedCount: 'Verified',
    notInSources: 'Not in sources',
    suggestedFixes: 'Suggested fixes',
    acceptedCount: 'Accepted',
    rejectedCount: 'Rejected',
    acceptAll: 'Accept all',
    accept: 'Accept',
    reject: 'Reject',
    kindTerm: 'Term',
    kindDuplicate: 'Repeat',
    kindTypo: 'Typo',
    playFromHere: 'Play from here',
    checkNotesTitle: 'Check my notes',
    checkPlaceholder: 'Paste what you wrote down from the lecture. Each sentence is checked against the lecture evidence.',
    checkButton: 'Check',
    checking: 'Checking…',
    noSources: 'No sources added yet.',
    statusPending: 'Queued',
    statusConverting: 'Converting',
    statusTranscribing: 'Transcribing',
    statusDone: 'Done',
    statusError: 'Error',
    transcribingProgress: 'Transcribing {done}/{total}',
    lengthLabel: 'Length {hms}',
    slidesLabel: '{count} slides',
    correctedMark: 'Fixed',
    correctedTitle: 'Original: {text}',
    playerRegion: 'Audio playback',
    play: 'Play',
    pause: 'Pause',
    seekLabel: 'Seek',
    slideRegion: 'Slide view',
    slideLoading: 'Loading…',
    slideRenderError: 'Could not render the slide.',
    slideLoadError: 'Could not load the slide.',
    prev: 'Previous',
    next: 'Next',
    openSample: 'Open sample note',
    sampleLanguageKo: 'Korean',
    sampleLanguageEn: 'English',
    emptyTitle: 'Sourcenote turns lecture recordings and slides into cited notes.',
    emptyHint: 'Explore a sample note right away — no API key needed.',
    importing: 'Importing…',
    noSamples: 'No samples available.',
  },
}

export type MessageKey = keyof typeof messages.ko

/** Looks up a message and fills `{param}` placeholders. */
export function t(
  lang: AppLanguage,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  let text: string = messages[lang][key]
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}

/** Display name of a sample language in the current UI language. */
export function sampleLanguageLabel(uiLang: AppLanguage, sampleLang: AppLanguage): string {
  if (sampleLang === 'en') return t(uiLang, 'sampleLanguageEn')
  return t(uiLang, 'sampleLanguageKo')
}
