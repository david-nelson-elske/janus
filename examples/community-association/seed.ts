/**
 * Seed script — populates the database with demo data.
 *
 * Usage: bun examples/community-association/seed.ts
 */
import { SYSTEM } from '@janus/core';
import type { App } from '@janus/http';

export async function seed(app: App) {
  const d = app.dispatch.bind(app);

  console.log('[seed] Seeding community association data...');

  // ── Membership Tiers ──────────────────────────────────────────
  const tiers = [
    { key: 'family', label: 'Family', priceCents: 4000, description: 'Household membership', sortOrder: 1, purchasable: true },
    { key: 'individual', label: 'Individual', priceCents: 2500, description: 'Single adult membership', sortOrder: 2, purchasable: true },
    { key: 'senior', label: 'Senior', priceCents: 1500, description: 'Senior (65+) membership', sortOrder: 3, purchasable: true },
    { key: 'nonresident', label: 'Non-Resident', priceCents: 2500, description: 'Non-resident membership', sortOrder: 4, purchasable: true },
    { key: 'business', label: 'Business', priceCents: 7500, description: 'Business membership', sortOrder: 5, purchasable: true },
    { key: 'honorary', label: 'Honorary', priceCents: 0, description: 'Complimentary membership', sortOrder: 6, purchasable: false },
  ];
  for (const tier of tiers) {
    await d('membership_tier', 'create', tier, SYSTEM);
  }
  console.log(`[seed] Created ${tiers.length} membership tiers`);

  // ── Facilities ────────────────────────────────────────────────
  const hallResult = await d('facility', 'create', {
    name: 'Community Hall',
    description: 'Main hall with kitchen and stage. Seats 200.',
    capacity: 200,
  }, SYSTEM);
  const hallId = (hallResult as { data?: { id: string } })?.data?.id;
  if (hallId) await d('facility', 'update:active', { id: hallId }, SYSTEM);

  const gardenResult = await d('facility', 'create', {
    name: 'Community Garden',
    description: '24 raised beds available for seasonal rental.',
    capacity: 24,
  }, SYSTEM);
  const gardenId = (gardenResult as { data?: { id: string } })?.data?.id;
  if (gardenId) await d('facility', 'update:active', { id: gardenId }, SYSTEM);
  console.log('[seed] Created 2 facilities');

  // ── Users ─────────────────────────────────────────────────────
  const users = [
    { email: 'admin@example.com', displayName: 'Admin User', role: 'admin' },
    { email: 'member@example.com', displayName: 'Test Member', role: 'member' },
    { email: 'jane@example.com', displayName: 'Jane Smith', role: 'member' },
  ];
  const userIds: string[] = [];
  for (const u of users) {
    const result = await d('user', 'create', u, SYSTEM);
    const id = (result as { data?: { id: string } })?.data?.id;
    if (id) userIds.push(id);
  }
  console.log(`[seed] Created ${users.length} users`);

  // ── Committees ────────────────────────────────────────────────
  const committeeResult = await d('committee', 'create', {
    name: 'Planning & Development',
    description: 'Reviews development applications and land use changes affecting the community.',
    purpose: 'Community advocacy on planning matters',
  }, SYSTEM);
  const committeeId = (committeeResult as { data?: { id: string } })?.data?.id;

  await d('committee', 'create', {
    name: 'Events & Programs',
    description: 'Organizes community events, programs, and social activities.',
    purpose: 'Community engagement and programming',
  }, SYSTEM);
  console.log('[seed] Created 2 committees');

  // ── Series (events) ───────────────────────────────────────────
  const yogaResult = await d('series', 'create', {
    title: 'Community Yoga',
    description: 'Weekly yoga class for all levels. Mats provided.',
    type: 'fitness',
    capacity: 30,
    priceCents: 0,
    sessionMode: 'series',
    defaultFacilityId: hallId,
  }, SYSTEM);
  const yogaId = (yogaResult as { data?: { id: string } })?.data?.id;
  if (yogaId) await d('series', 'update:published', { id: yogaId }, SYSTEM);

  const movieResult = await d('series', 'create', {
    title: 'Movie Night',
    description: 'Monthly outdoor movie screenings. Bring your own chair.',
    type: 'social',
    capacity: 100,
    priceCents: 500,
    sessionMode: 'drop-in',
    defaultFacilityId: hallId,
  }, SYSTEM);
  const movieId = (movieResult as { data?: { id: string } })?.data?.id;
  if (movieId) await d('series', 'update:published', { id: movieId }, SYSTEM);
  console.log('[seed] Created 2 series');

  // ── Sessions ──────────────────────────────────────────────────
  const now = new Date();
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const nextMonth = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  if (yogaId && hallId) {
    await d('session', 'create', {
      startsAt: nextWeek.toISOString(),
      endsAt: new Date(nextWeek.getTime() + 60 * 60 * 1000).toISOString(),
      seriesId: yogaId,
      facilityId: hallId,
    }, SYSTEM);
  }
  if (movieId && hallId) {
    await d('session', 'create', {
      startsAt: nextMonth.toISOString(),
      endsAt: new Date(nextMonth.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      seriesId: movieId,
      facilityId: hallId,
    }, SYSTEM);
  }
  console.log('[seed] Created 2 sessions');

  // ── Content ───────────────────────────────────────────────────
  const contentResult = await d('content', 'create', {
    title: 'Welcome to the Community',
    body: 'We are a vibrant community association dedicated to building connections between neighbours.',
    slug: 'welcome',
    category: 'announcement',
  }, SYSTEM);
  const contentId = (contentResult as { data?: { id: string } })?.data?.id;
  if (contentId) await d('content', 'update:published', { id: contentId }, SYSTEM);
  console.log('[seed] Created 1 content page');

  // ── Garden Beds ───────────────────────────────────────────────
  if (gardenId) {
    for (let i = 1; i <= 6; i++) {
      await d('garden_bed', 'create', {
        label: `Bed ${i}`,
        ring: i <= 3 ? 'Inner Ring' : 'Outer Ring',
        position: i,
        facilityId: gardenId,
      }, SYSTEM);
    }
    console.log('[seed] Created 6 garden beds');
  }

  // ── Volunteer Positions ───────────────────────────────────────
  const volResult = await d('volunteer_position', 'create', {
    title: 'Event Setup Crew',
    description: 'Help set up and tear down for community events.',
    slotsNeeded: 5,
  }, SYSTEM);
  const volId = (volResult as { data?: { id: string } })?.data?.id;
  if (volId) await d('volunteer_position', 'update:active', { id: volId }, SYSTEM);
  console.log('[seed] Created 1 volunteer position');

  console.log('[seed] Done!');
}
