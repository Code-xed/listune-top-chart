import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';

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

type ChartPeriod = 'daily' | 'weekly';
type RequestedPeriod = ChartPeriod | 'toplists';
type ScrapedTrack = {
  trackId?: string;
  trackName: string;
  artistName: string;
  rank: number;
  streams: number;
  totalStreams?: number;
  spotifyUrl?: string;
  category?: string;
  kworbUrl?: string;
};

function parseNumber(value: string): number {
  const cleaned = (value || '').replace(/[,+\s]/g, '').trim();
  if (!cleaned || cleaned === '--') return 0;
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)([KMB])?$/i);
  if (!match) return 0;
  const multiplier = {
    K: 1_000,
    M: 1_000_000,
    B: 1_000_000_000,
  }[(match[2] || '').toUpperCase()] || 1;
  const valueNumber = Number(match[1]);
  return Number.isFinite(valueNumber)
    ? Math.round(valueNumber * multiplier)
    : 0;
}

function getTrackId(href?: string): string | undefined {
  if (!href) return undefined;
  // Kworb links to /spotify/track/<Spotify-ID>.html, not directly to Spotify.
  return href.match(/\/track\/([A-Za-z0-9]+)/)?.[1];
}

async function scrapeKworbChart(
  country: string,
  period: ChartPeriod,
): Promise<ScrapedTrack[]> {
  const url = `https://kworb.net/spotify/country/${country}_${period}.html`;
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Kworb returned HTTP ${response.status} for ${url}`);
  }

  const $ = cheerio.load(await response.text());

  // The live Kworb weekly table has columns:
  // Pos | P+ | Artist and Title | Wks | Pk | (x?) | Streams | Streams+ | Total
  // Find the actual chart table/header instead of relying on a table ID.
  let $table = $('table').filter((_, table) => {
    const text = $(table).text();
    return text.includes('Artist and Title') && text.includes('Streams');
  }).first();

  if (!$table.length) {
    throw new Error(`Could not find the ${period} chart table at ${url}`);
  }

  const headerRow = $table.find('tr').toArray().find((row) => {
    const rowText = $(row).text();
    return rowText.includes('Artist and Title') && rowText.includes('Streams');
  });

  if (!headerRow) {
    throw new Error(`Could not find the ${period} chart headers at ${url}`);
  }

  const headers = $(headerRow)
    .find('th, td')
    .toArray()
    .map((cell) => $(cell).text().replace(/\s+/g, ' ').trim().toLowerCase());

  const rankIndex = headers.findIndex((header) => header === 'pos');
  const artistTitleIndex = headers.findIndex((header) => header === 'artist and title');
  const streamsIndex = headers.findIndex((header) => header === 'streams');
  const totalIndex = headers.findIndex((header) => header === 'total');

  if (rankIndex < 0 || artistTitleIndex < 0 || streamsIndex < 0) {
    throw new Error(
      `Unexpected ${period} chart columns at ${url}: ${headers.join(' | ')}`,
    );
  }

  const tracks: ScrapedTrack[] = [];
  const seenRanks = new Set<number>();

  $table.find('tr').each((_, row) => {
    if (row === headerRow) return;
    const $row = $(row);
    const cells = $row.find('td').toArray();
    if (!cells.length) return;

    const rankText = $(cells[rankIndex]).text().trim();
    const rank = Number.parseInt(rankText.replace(/[^\d]/g, ''), 10);
    if (!Number.isInteger(rank) || rank < 1 || rank > 200 || seenRanks.has(rank)) return;

    const $artistTitle = $(cells[artistTitleIndex]);
    const artistTitleText = $artistTitle.text().replace(/\s+/g, ' ').trim();
    const separatorIndex = artistTitleText.indexOf(' - ');
    if (separatorIndex < 1) return;

    const artistName = artistTitleText.slice(0, separatorIndex).trim();
    const trackName = artistTitleText.slice(separatorIndex + 3).trim();
    if (!artistName || !trackName) return;

    const streams = parseNumber($(cells[streamsIndex]).text());
    // Some country weekly charts currently report zero streams. Keep those
    // rows because zero is the value Kworb publishes, not a parse failure.
    const totalStreams = totalIndex >= 0
      ? parseNumber($(cells[totalIndex]).text()) || undefined
      : undefined;

    const trackHref = $artistTitle.find('a[href*="/track/"]').first().attr('href');
    const trackId = getTrackId(trackHref);

    seenRanks.add(rank);
    tracks.push({
      trackId,
      trackName,
      artistName,
      rank,
      streams,
      totalStreams,
      spotifyUrl: trackId ? `https://open.spotify.com/track/${trackId}` : undefined,
    });
  });

  tracks.sort((a, b) => a.rank - b.rank);
  if (!tracks.length) {
    throw new Error(`No tracks could be parsed from the ${period} chart at ${url}`);
  }
  return tracks;
}


async function scrapeKworbTopLists(): Promise<ScrapedTrack[]> {
  const url = 'https://kworb.net/spotify/toplists.html';
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Kworb returned HTTP ${response.status} for ${url}`);
  }

  const $ = cheerio.load(await response.text());
  // The first table is the songs Top Lists. The second table is albums.
  const $table = $('table').filter((_, table) => {
    const headers = $(table)
      .find('tr')
      .toArray()
      .map((row) => $(row).find('th, td').toArray().map((cell) =>
        $(cell).text().replace(/\s+/g, ' ').trim().toLowerCase(),
      ));
    return headers.some((row) =>
      row.includes('artist and title') && row.includes('streams'),
    );
  }).first();

  if (!$table.length) {
    throw new Error(`Could not find the songs Top Lists table at ${url}`);
  }

  const rows = $table.find('tr').toArray();
  const headerRow = rows.find((row) => {
    const cells = $(row).find('th, td').toArray().map((cell) =>
      $(cell).text().replace(/\s+/g, ' ').trim().toLowerCase(),
    );
    return cells.includes('artist and title') && cells.includes('streams');
  });

  if (!headerRow) {
    throw new Error(`Could not find Top Lists headers at ${url}`);
  }

  const headers = $(headerRow).find('th, td').toArray().map((cell) =>
    $(cell).text().replace(/\s+/g, ' ').trim().toLowerCase(),
  );
  const titleIndex = headers.findIndex((header) => header === 'artist and title');
  const streamsIndex = headers.findIndex((header) => header === 'streams');
  if (titleIndex < 0 || streamsIndex < 0) {
    throw new Error(`Unexpected Top Lists columns at ${url}: ${headers.join(' | ')}`);
  }

  const tracks: ScrapedTrack[] = [];
  for (const row of rows) {
    if (row === headerRow) continue;
    const $cells = $(row).find('td');
    if ($cells.length <= Math.max(titleIndex, streamsIndex)) continue;

    const category = $($cells.get(0)).text().replace(/\s+/g, ' ').trim();
    const $titleCell = $($cells.get(titleIndex));
    const artistTitle = $titleCell.text().replace(/\s+/g, ' ').trim();
    const separatorIndex = artistTitle.indexOf(' - ');
    if (separatorIndex < 1) continue;

    const artistName = artistTitle.slice(0, separatorIndex).trim();
    const trackName = artistTitle.slice(separatorIndex + 3).trim();
    const streams = parseNumber($($cells.get(streamsIndex)).text());
    if (!artistName || !trackName || streams <= 0) continue;

    const href = $titleCell.find('a').first().attr('href');
    const kworbUrl = href ? new URL(href, url).toString() : url;
    const trackId = getTrackId(href);

    tracks.push({
      trackId,
      trackName,
      artistName,
      rank: tracks.length + 1,
      streams,
      totalStreams: streams,
      spotifyUrl: trackId ? `https://open.spotify.com/track/${trackId}` : undefined,
      category: category || 'Top Lists',
      kworbUrl,
    });
  }

  if (!tracks.length) {
    throw new Error(`No songs could be parsed from Kworb Top Lists at ${url}`);
  }
  return tracks;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const country = (searchParams.get('country') || 'global').trim().toLowerCase();
    const requestedLimit = Number.parseInt(searchParams.get('limit') || '25', 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 200))
      : 25;

    const requestedPeriod = (searchParams.get('period') || 'daily').trim().toLowerCase();
    if (requestedPeriod !== 'daily' && requestedPeriod !== 'weekly' && requestedPeriod !== 'toplists') {
      return NextResponse.json(
        {
          error: 'Unsupported chart period',
          supportedPeriods: ['daily', 'weekly', 'toplists'],
          details: 'Kworb Top Lists is available as period=toplists. Monthly charts are not included.',
        },
        { status: 400 },
      );
    }
    const period = requestedPeriod as RequestedPeriod;

    // Top Lists is a global Kworb page, not a country chart.
    if (period !== 'toplists' && !SUPPORTED_COUNTRIES[country]) {
      return NextResponse.json(
        {
          error: 'Unsupported country',
          supportedCountries: Object.keys(SUPPORTED_COUNTRIES),
        },
        { status: 400 },
      );
    }

    let rawTracks: ScrapedTrack[];
    if (period === 'toplists') {
      rawTracks = await scrapeKworbTopLists();
    } else if (period === 'weekly') {
      // Real weekly chart data from Kworb, not a sum of daily counts.
      rawTracks = await scrapeKworbChart(country, 'weekly');
    } else {
      const dailyTracks = country === 'global'
        ? await scrapeKworbGlobalDailyTracks()
        : await scrapeKworbCountryDailyTracks(country);
      rawTracks = dailyTracks.map((track) => ({
        trackId: track.trackId,
        trackName: track.trackName,
        artistName: track.artistName,
        rank: track.rank,
        streams: track.dailyStreams,
        totalStreams: track.totalStreams,
        spotifyUrl: track.spotifyUrl,
      }));
    }

    const search = (searchParams.get('search') || searchParams.get('q') || '')
      .trim()
      .toLocaleLowerCase();
    const matchingTracks = search
      ? rawTracks.filter((track) =>
          `${track.trackName} ${track.artistName}`.toLocaleLowerCase().includes(search),
        )
      : rawTracks;

    const selectedTracks = matchingTracks.slice(0, limit);
    const tracks = await Promise.all(selectedTracks.map(async (track) => {
      let imageUrl: string | undefined;
      let spotifyUrl = track.spotifyUrl;

      if (track.trackId) {
        try {
          const metadata = await resolveTrackOEmbed(track.trackId);
          if (metadata) {
            imageUrl = metadata.imageUrl;
            spotifyUrl = metadata.url || spotifyUrl;
          }
        } catch (error) {
          console.warn(`Artwork lookup failed for ${track.trackName}:`, error);
        }
      }

      return {
        trackId: track.trackId ?? null,
        name: track.trackName,
        mainArtistName: track.artistName,
        rank: track.rank,
        previousRank: null,
        rankDelta: null,
        dailyStreams: period === 'daily' ? track.streams : null,
        weeklyStreams: period === 'weekly' ? track.streams : null,
        streams: track.streams,
        periodStreams: track.streams,
        totalStreams: track.totalStreams ?? null,
        category: track.category ?? null,
        kworbUrl: track.kworbUrl ?? null,
        imageUrl: imageUrl ?? null,
        previewUrl: null,
        spotifyUrl: spotifyUrl ?? null,
      };
    }));

    return NextResponse.json(
      {
        country: period === 'toplists' ? 'global' : country,
        period,
        count: tracks.length,
        lastUpdated: new Date().toISOString(),
        ...(search ? { search } : {}),
        tracks,
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
        },
      },
    );
  } catch (error) {
    console.error('Direct Kworb chart request failed:', error);
    return NextResponse.json(
      {
        error: 'Failed to fetch Spotify charts',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 502 },
    );
  }
}
