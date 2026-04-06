import { describe, expect, test } from 'bun:test';
import {
  Asset,
  Availability,
  Bool,
  Color,
  Cron,
  DateTime,
  Duration,
  Email,
  Enum,
  Float,
  Icon,
  Id,
  Int,
  IntBps,
  IntCents,
  isSemanticField,
  Json,
  LatLng,
  Markdown,
  Phone,
  QrCode,
  Recurrence,
  Scope,
  Slug,
  Str,
  Token,
  Url,
} from '..';
import { Relation } from '../wiring-types';

describe('value types', () => {
  test('Str returns correct kind', () => {
    const f = Str();
    expect(f.kind).toBe('str');
    expect(f.hints).toEqual({});
  });

  test('Str with hints preserves them', () => {
    const f = Str({ required: true, as: 'title', multiline: true, boost: 2 });
    expect(f.hints.required).toBe(true);
    expect(f.hints.as).toBe('title');
    expect(f.hints.multiline).toBe(true);
    expect(f.hints.boost).toBe(2);
  });

  test('Int, Float, Bool, Json return correct kinds', () => {
    expect(Int().kind).toBe('int');
    expect(Float().kind).toBe('float');
    expect(Bool().kind).toBe('bool');
    expect(Json().kind).toBe('json');
  });

  test('Enum stores values as frozen array', () => {
    const f = Enum(['draft', 'published', 'archived']);
    expect(f.kind).toBe('enum');
    expect(f.values).toEqual(['draft', 'published', 'archived']);
    expect(Object.isFrozen(f.values)).toBe(true);
  });

  test('Enum with default hint', () => {
    const f = Enum(['a', 'b'], { default: 'a' });
    expect(f.hints.default).toBe('a');
  });
});

describe('temporal types', () => {
  test('DateTime returns correct kind', () => {
    expect(DateTime().kind).toBe('datetime');
  });

  test('DateTime with decay hint', () => {
    const f = DateTime({ decay: '7d' });
    expect(f.hints.decay).toBe('7d');
  });

  test('Duration (field) returns correct kind', () => {
    const f = Duration();
    expect(f.kind).toBe('duration');
  });
});

describe('monetary types', () => {
  test('IntCents and IntBps return correct kinds', () => {
    expect(IntCents().kind).toBe('intcents');
    expect(IntBps().kind).toBe('intbps');
  });
});

describe('identity types', () => {
  test('all identity types return correct kinds', () => {
    expect(Id().kind).toBe('id');
    expect(Slug().kind).toBe('slug');
    expect(Email().kind).toBe('email');
    expect(Phone().kind).toBe('phone');
    expect(Url().kind).toBe('url');
    expect(Token().kind).toBe('token');
    expect(Scope().kind).toBe('scope');
  });

  test('Token with config', () => {
    const f = Token({ prefix: 'tk_', length: 32 });
    expect(f.hints.prefix).toBe('tk_');
    expect(f.hints.length).toBe(32);
  });
});

describe('content types', () => {
  test('Markdown, Cron, Asset return correct kinds', () => {
    expect(Markdown().kind).toBe('markdown');
    expect(Cron().kind).toBe('cron');
    expect(Asset().kind).toBe('asset');
  });

  test('Asset with MIME and size constraints', () => {
    const f = Asset({ accept: 'image/*', maxSize: 5_000_000 });
    expect(f.hints.accept).toBe('image/*');
    expect(f.hints.maxSize).toBe(5_000_000);
  });
});

describe('visual types', () => {
  test('Color and Icon return correct kinds', () => {
    expect(Color().kind).toBe('color');
    expect(Icon().kind).toBe('icon');
  });
});

describe('compound types', () => {
  test('Recurrence stores target', () => {
    const f = Recurrence('event-instance');
    expect(f.kind).toBe('recurrence');
    expect(f.target).toBe('event-instance');
  });

  test('Availability returns correct kind', () => {
    expect(Availability().kind).toBe('availability');
  });

  test('QrCode with config', () => {
    const f = QrCode({ singleUse: true, length: 8 });
    expect(f.kind).toBe('qrcode');
    expect(f.hints.singleUse).toBe(true);
    expect(f.hints.length).toBe(8);
  });

  test('LatLng returns correct kind', () => {
    expect(LatLng().kind).toBe('latlng');
  });
});

describe('immutability', () => {
  test('all returned objects are frozen', () => {
    expect(Object.isFrozen(Str())).toBe(true);
    expect(Object.isFrozen(Str().hints)).toBe(true);
    expect(Object.isFrozen(Enum(['a', 'b']))).toBe(true);
    expect(Object.isFrozen(Int({ required: true }))).toBe(true);
  });
});

describe('isSemanticField', () => {
  test('returns true for all semantic types', () => {
    expect(isSemanticField(Str())).toBe(true);
    expect(isSemanticField(Int())).toBe(true);
    expect(isSemanticField(DateTime())).toBe(true);
    expect(isSemanticField(Enum(['a']))).toBe(true);
    expect(isSemanticField(LatLng())).toBe(true);
    expect(isSemanticField(Markdown())).toBe(true);
  });

  test('returns false for wiring types', () => {
    expect(isSemanticField(Relation('user'))).toBe(false);
  });

  test('returns false for non-objects', () => {
    expect(isSemanticField(null)).toBe(false);
    expect(isSemanticField('str')).toBe(false);
    expect(isSemanticField(42)).toBe(false);
  });
});
