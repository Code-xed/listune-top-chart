import { NextResponse } from 'next/server';

import {
scrapeKworbGlobalDailyTracks,
} from '@/lib/scraping/kworbTracks';

import {
scrapeKworbCountryDailyTracks,
SUPPORTED_COUNTRIES,
} from '@/lib/scraping/kworbCountry';

import { resolveTrackOEmbed } from '@/lib/spotify/metadata';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ChartPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

function jsonError(
error: string,
status: number,
details?: string
) {
return NextResponse.json(
{
error,
...(details ? { details } : {}),
},
{ status }
);
}

export async function GET(request: Request) {
try {
const { searchParams } = new URL(request.url);

const country = (
  searchParams.get('country') || 'global'
).trim().toLowerCase();

const requestedLimit = Number.parseInt(
  searchParams.get('limit') || '25',
  10
);

const limit = Number.isFinite(requestedLimit)
  ? Math.max(1, Math.min(requestedLimit, 200))
  : 25;

const requestedPeriod = (
  searchParams.get('period') || 'daily'
).trim().toLowerCase();

const supportedPeriods: ChartPeriod[] = [
  'daily',
  'weekly',
  'monthly',
  'yearly',
];

if (!supportedPeriods.includes(requestedPeriod as ChartPeriod)) {
  return NextResponse.json(
    {
      error: 'Unsupported chart period',
      supportedPeriods,
    },
    { status: 400 }
  );
}

const period = requestedPeriod as ChartPeriod;

if (!SUPPORTED_COUNTRIES[country]) {
  return NextResponse.json(
    {
      error: 'Unsupported country',
      supportedCountries: Object.keys(SUPPORTED_COUNTRIES),
    },
    { status: 400 }
  );
}

/*
 * The currently installed scrapers only expose daily charts.
 * Do not mislabel daily rankings as weekly, monthly, or yearly.
 *
 * Add the corresponding Kworb historical/period scraper here
 * when its source and response format have been verified.
 */
if (period !== 'daily') {
  return NextResponse.json(
    {
      error: `The ${period} chart is not implemented yet`,
      period,
      country,
      supportedPeriods: ['daily'],
      details:
        'The current scraper functions only fetch daily charts. Weekly, monthly, and yearly charts require their own data source.',
    },
    { status: 501 }
  );
}

// Fetch directly from Kworb. No database.
const rawTracks =
  country === 'global'
    ? await scrapeKworbGlobalDailyTracks()
    : await scrapeKworbCountryDailyTracks(country);

/*
 * Optional search:
 * ?country=global&period=daily&search=song%20name
 *
 * Searches the tracks returned by the chart scraper.
 * It does not search Spotify's entire catalogue.
 */
const search = (
  searchParams.get('search') ||
  searchParams.get('q') ||
  ''
)
  .trim()
  .toLowerCase();

const matchingTracks = search
  ? rawTracks.filter((track) => {
      const name = track.trackName || '';
      const artist = track.artistName || '';

      return (
        name.toLowerCase().includes(search) ||
        artist.toLowerCase().includes(search)
      );
    })
  : rawTracks;

const selectedTracks = matchingTracks.slice(0, limit);

// Resolve Spotify artwork and links when a Spotify track ID exists.
const tracks = await Promise.all(
  selectedTracks.map(async (track) => {
    let imageUrl: string | undefined;

    let spotifyUrl =
      track.spotifyUrl ||
      (track.trackId
        ? `https://open.spotify.com/track/${track.trackId}`
        : undefined);

    if (track.trackId) {
      try {
        const metadata = await resolveTrackOEmbed(track.trackId);

        if (metadata) {
          imageUrl = metadata.imageUrl;
          spotifyUrl = metadata.url || spotifyUrl;
        }
      } catch (error) {
        console.warn(
          `Artwork lookup failed for ${track.trackName}:`,
          error
        );
      }
    }

    return {
      trackId: track.trackId ?? null,
      name: track.trackName,
      mainArtistName: track.artistName,
      rank: track.rank,

      // No database means no stored previous ranking.
      previousRank: null,
      rankDelta: null,

      dailyStreams: track.dailyStreams,
      totalStreams: track.totalStreams ?? null,

      imageUrl: imageUrl ?? null,
      previewUrl: null,
      spotifyUrl: spotifyUrl ?? null,
    };
  })
);

return NextResponse.json(
  {
    country,
    period,
    count: tracks.length,
    lastUpdated: new Date().toISOString(),
    ...(search ? { search } : {}),
    tracks,
  },
  {
    headers: {
      'Cache-Control':
        'public, s-maxage=1800, stale-while-revalidate=3600',
    },
  }
);

} catch (error) {
console.error('Direct Kworb chart request failed:', error);

return NextResponse.json(
  {
    error: 'Failed to fetch Spotify charts',
    details:
      error instanceof Error ? error.message : 'Unknown error',
  },
  { status: 502 }
);

}
}
