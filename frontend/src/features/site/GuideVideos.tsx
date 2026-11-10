import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

// Walkthrough videos for each setup tier. The files are hosted-only (a
// gitignored folder under public/guide/videos, shipped with the hosted build),
// so self-hosted installs have no manifest and this renders nothing at all.
export interface GuideVideo {
  tier: 'quick' | 'partial' | 'full';
  src: string;
  poster?: string;
  duration?: string;
  /** WebVTT of the narration (English), when the video is narrated. */
  captions?: string;
}

const MANIFEST_URL = '/guide/videos/videos.json';

// One WebVTT cue: start and end in seconds, plus its text.
export interface CaptionCue { start: number; end: number; text: string }

function vttSeconds(stamp: string): number | null {
  const m = stamp.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

// A small WebVTT reader for the narration files (cue id, timing line, text).
export function parseVtt(source: string): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const block of source.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0) continue;
    const [from = '', rest = ''] = lines[at]!.split('-->');
    const start = vttSeconds(from);
    const end = vttSeconds(rest.trim().split(/\s+/)[0] ?? '');
    const text = lines.slice(at + 1).join('\n');
    if (start !== null && end !== null && end > start && text) cues.push({ start, end, text });
  }
  return cues;
}

// Subtitles for a player WITHOUT a <track> element. iPhone Safari refused to
// load the whole video when the player held a <track> (2026-11-08: plain and
// muted players played, both with a track did not). So the captions are
// fetched and added through the TextTrack API once the video has metadata;
// if anything about them fails, the video still plays, just without them.
export function useCaptions(video: RefObject<HTMLVideoElement | null>, url: string | undefined, label: string) {
  useEffect(() => {
    const el = video.current;
    if (!el || !url || typeof el.addTextTrack !== 'function' || typeof VTTCue === 'undefined') return;
    let cancelled = false;
    let added = false;
    const add = () => {
      if (added) return;
      added = true;
      fetch(url)
        .then((response) => (response.ok ? response.text() : ''))
        .then((source) => {
          if (cancelled || !source) return;
          const track = el.addTextTrack('subtitles', label, 'en');
          for (const cue of parseVtt(source)) track.addCue(new VTTCue(cue.start, cue.end, cue.text));
          track.mode = 'hidden';
        })
        .catch(() => { /* no subtitles; the video plays on */ });
    };
    if (el.readyState >= 1) add();
    else el.addEventListener('loadedmetadata', add, { once: true });
    return () => { cancelled = true; el.removeEventListener('loadedmetadata', add); };
  }, [video, url, label]);
}
const ORDER: GuideVideo['tier'][] = ['quick', 'partial', 'full'];

export function parseGuideVideos(data: unknown): GuideVideo[] {
  const list = (data && typeof data === 'object' && Array.isArray((data as { videos?: unknown }).videos))
    ? (data as { videos: unknown[] }).videos : [];
  return list.flatMap((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const tier = item['tier'];
    const src = item['src'];
    if ((tier !== 'quick' && tier !== 'partial' && tier !== 'full') || typeof src !== 'string' || !src.startsWith('/guide/videos/')) return [];
    const video: GuideVideo = { tier, src };
    if (typeof item['poster'] === 'string' && item['poster'].startsWith('/guide/videos/')) video.poster = item['poster'];
    if (typeof item['duration'] === 'string') video.duration = item['duration'];
    if (typeof item['captions'] === 'string' && item['captions'].startsWith('/guide/videos/')) video.captions = item['captions'];
    return [video];
  }).sort((a, b) => ORDER.indexOf(a.tier) - ORDER.indexOf(b.tier));
}

// The whole-app overview shown from the home page hero. Same hosted-only
// manifest, as an optional top-level "overview" entry.
export interface OverviewVideo {
  src: string;
  poster?: string;
  duration?: string;
  captions?: string;
}

export function parseOverviewVideo(data: unknown, key: 'overview' | 'jellyfin' = 'overview'): OverviewVideo | null {
  const raw = data && typeof data === 'object' ? (data as Record<string, unknown>)[key] : null;
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const src = item['src'];
  if (typeof src !== 'string' || !src.startsWith('/guide/videos/')) return null;
  const video: OverviewVideo = { src };
  if (typeof item['poster'] === 'string' && item['poster'].startsWith('/guide/videos/')) video.poster = item['poster'];
  if (typeof item['duration'] === 'string') video.duration = item['duration'];
  if (typeof item['captions'] === 'string' && item['captions'].startsWith('/guide/videos/')) video.captions = item['captions'];
  return video;
}

export function GuideVideos() {
  const { t } = useTranslation('site');
  const [videos, setVideos] = useState<GuideVideo[]>([]);
  const [active, setActive] = useState<GuideVideo['tier'] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(MANIFEST_URL, { cache: 'no-cache' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled) return;
        const parsed = parseGuideVideos(data);
        setVideos(parsed);
        setActive(parsed.find((video) => video.tier === 'partial')?.tier ?? parsed[0]?.tier ?? null);
      })
      .catch(() => { /* no videos on this instance */ });
    return () => { cancelled = true; };
  }, []);

  const current = videos.find((video) => video.tier === active);
  const player = useRef<HTMLVideoElement>(null);
  useCaptions(player, current?.captions, t('guide.videos.subtitles'));
  if (!current) return null;

  return (
    <div className="gd-videos">
      <div className="gd-videos-head">
        <div>
          <span className="section-eyebrow">{t('guide.videos.eyebrow')}</span>
          <h3>{t('guide.videos.title')}</h3>
          <p>{t('guide.videos.lede')}</p>
        </div>
        <div className="gd-video-tabs" role="tablist" aria-label={t('guide.videos.title')}>
          {videos.map((video) => (
            <button
              key={video.tier} type="button" role="tab" aria-selected={video.tier === active}
              className={video.tier === active ? 'is-active' : ''}
              onClick={() => setActive(video.tier)}
            >
              <strong>{t(`guide.videos.tiers.${video.tier}`)}</strong>
              {video.duration && <small>{video.duration}</small>}
            </button>
          ))}
        </div>
      </div>
      <div className="gd-video-frame">
        <video
          ref={player}
          key={current.src}
          controls playsInline preload="none"
          {...(current.poster ? { poster: current.poster } : {})}
          aria-label={t(`guide.videos.tiers.${current.tier}`)}
        >
          <source src={current.src} type="video/mp4" />
        </video>
      </div>
    </div>
  );
}
