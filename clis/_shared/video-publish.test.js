import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseScheduleDate, resolveVideoFile, resolveImageFile } from './video-publish.js';

describe('video-publish shared helpers', () => {
  describe('parseScheduleDate', () => {
    it('returns null for empty / nullish', () => {
      expect(parseScheduleDate('')).toBeNull();
      expect(parseScheduleDate(null)).toBeNull();
      expect(parseScheduleDate(undefined)).toBeNull();
    });

    it('parses a future ISO8601 string', () => {
      const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
      const dt = parseScheduleDate(future);
      expect(dt).toBeInstanceOf(Date);
      expect(dt.getTime()).toBeGreaterThan(Date.now());
    });

    it('parses future Unix seconds and milliseconds', () => {
      const secs = Math.floor(Date.now() / 1000) + 3600;
      expect(parseScheduleDate(secs).getTime()).toBe(secs * 1000);
      const ms = Date.now() + 3600_000;
      expect(parseScheduleDate(ms).getTime()).toBe(ms);
    });

    it('throws on an unparseable time', () => {
      expect(() => parseScheduleDate('not-a-date')).toThrow();
    });

    it('throws on a past time', () => {
      const past = new Date(Date.now() - 3600_000).toISOString();
      expect(() => parseScheduleDate(past)).toThrow();
    });
  });

  describe('resolveVideoFile', () => {
    it('accepts a real video file and returns an absolute path', () => {
      const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vp-')), 'a.mp4');
      fs.writeFileSync(p, 'x');
      expect(resolveVideoFile(p)).toBe(path.resolve(p));
    });

    it('rejects a missing file', () => {
      expect(() => resolveVideoFile('/no/such/file.mp4')).toThrow();
    });

    it('rejects an unsupported extension', () => {
      const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vp-')), 'a.txt');
      fs.writeFileSync(p, 'x');
      expect(() => resolveVideoFile(p)).toThrow();
    });
  });

  describe('resolveImageFile', () => {
    it('accepts a real image file', () => {
      const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vp-')), 'a.jpg');
      fs.writeFileSync(p, 'x');
      expect(resolveImageFile(p)).toBe(path.resolve(p));
    });

    it('rejects an unsupported extension', () => {
      const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vp-')), 'a.mp4');
      fs.writeFileSync(p, 'x');
      expect(() => resolveImageFile(p)).toThrow();
    });
  });
});
