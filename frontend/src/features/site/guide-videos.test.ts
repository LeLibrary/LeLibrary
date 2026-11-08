import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseGuideVideos, parseOverviewVideo, parseVtt } from '@/features/site/GuideVideos';

describe('videos manifest', () => {
  const manifest = {
    videos: [{ tier: 'quick', src: '/guide/videos/quick.mp4', poster: '/guide/videos/quick.jpg', duration: '1:25' }],
    overview: { src: '/guide/videos/overview.mp4', poster: '/guide/videos/overview.jpg', duration: '1:13' },
  };

  it('reads the home page overview next to the tier videos', () => {
    expect(parseOverviewVideo(manifest)).toEqual({ src: '/guide/videos/overview.mp4', poster: '/guide/videos/overview.jpg', duration: '1:13' });
    expect(parseGuideVideos(manifest).map((video) => video.tier)).toEqual(['quick']);
  });

  it('has no overview when the entry is missing or points elsewhere', () => {
    expect(parseOverviewVideo({ videos: [] })).toBeNull();
    expect(parseOverviewVideo({ overview: { src: '/guide/videos/o.mp4', captions: '/guide/videos/o.vtt?v=1' } })?.captions).toBe('/guide/videos/o.vtt?v=1');
    expect(parseOverviewVideo({ overview: { src: '/guide/videos/o.mp4', captions: 'https://evil.example/o.vtt' } })?.captions).toBeUndefined();
    expect(parseOverviewVideo(null)).toBeNull();
    expect(parseOverviewVideo({ overview: { src: 'https://evil.example/x.mp4' } })).toBeNull();
    expect(parseOverviewVideo({ overview: { src: '/guide/videos/o.mp4', poster: 'https://evil.example/p.jpg' } })).toEqual({ src: '/guide/videos/o.mp4' });
  });

  it('keeps narration subtitles only from the videos folder', () => {
    const [narrated] = parseGuideVideos({ videos: [{ tier: 'quick', src: '/guide/videos/quick.mp4', captions: '/guide/videos/quick.vtt?v=1' }] });
    expect(narrated?.captions).toBe('/guide/videos/quick.vtt?v=1');
    const [other] = parseGuideVideos({ videos: [{ tier: 'quick', src: '/guide/videos/quick.mp4', captions: 'https://evil.example/x.vtt' }] });
    expect(other?.captions).toBeUndefined();
  });
});

describe('captions without a <track> element', () => {
  it('reads the narration WebVTT cues', () => {
    const cues = parseVtt('WEBVTT\n\n1\n00:00:04.100 --> 00:00:09.889\nWelcome to LeLibrary.\n\n2\n00:01:02.000 --> 00:01:05.500 align:start\nTwo\nlines\n\nbroken --> cue\nskip me\n');
    expect(cues).toEqual([
      { start: 4.1, end: 9.889, text: 'Welcome to LeLibrary.' },
      { start: 62, end: 65.5, text: 'Two\nlines' },
    ]);
  });

  it('players never render a <track> (iPhone Safari will not load the video with one)', () => {
    const src = readFileSync(new URL('./GuideVideos.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/<track\s/);
    expect(src).toContain('useCaptions(player');
  });
});
