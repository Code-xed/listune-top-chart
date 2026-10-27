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

type ChartTrack = {
  trackId?: string;
  trackName: string;
  artistName: string;
  rank: number;
  streams: number;
  totalStreams?: number;
  spotifyUrl?: string;
};

function parseNumber(value: string): number {
  const cleaned = value.replace(/,/g, '').trim();
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : 0;
}

async function scrapeKworbWeeklyTracks(
  country: string
): Promise<ChartTrack[]> {
  const url =
    `https://kworb.net/spotify/country/${country}_weekly.html`;

  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(
      `Kworb weekly chart returned HTTP ${response.status}: ${url}`
    );
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  // Find the chart table containing the expected column headers.
  const table = $('table')
    .toArray()
    .find((element) => {
      const text = $(element).text();

      return (
        text.includes('Artist and Title') &&
        text.includes('Streams')
      );
    });

  if (!table) {
    throw new Error(
      `Could not find the weekly chart table for ${country}`
    );
  }

  const tracks: ChartTrack[] = [];
  const seenRanks = new Set<number>();

  $(table)
    .find('tr')
    .each((_, row) => {
      const cells = $(row).find('td');

      if (cells.length < 7) return;

      const rank = Number.parseInt(
        $(cells[0]).text().trim(),
        10
      );

      if (
        !Number.isInteger(rank) ||
        rank < 1 ||
        rank > 200 ||
        seenRanks.has(rank)
      ) {
        return;
      }

      const artistTitleCell = $(cells[2]);
      const artistTitle = artistTitleCell
        .text()
        .replace(/\s+/g, ' ')
        .trim();

      // Split only at the first separator.
      const separator = artistTitle.indexOf(' - ');

      if (separator < 1) return;

      const artistName = artistTitle
        .slice(0, separator)
        .trim();

      const trackName = artistTitle
        .slice(separator + 3)
        .trim();

      if (!artistName || !trackName) return;

      // Kworb's weekly Streams column is index 6.
      const streams = parseNumber(
        $(cells[6]).text()
      );

      if (streams <= 0) return;

      const trackLink = artistTitleCell
        .find('a[href*="/track/"]')
        .attr('href');

      const match = trackLink?.match(
        /\/track\/([a-zA-Z0-9]+)/
      );

      const trackId = match?.[1];

      const totalStreams = parseNumber(
        $(cells[cells.length - 1]).text()
      );

      seenRanks.add(rank);

      tracks.push({
        trackId,
        trackName,
        artistName,
        rank,
        streams,
        totalStreams: totalStreams || undefined,
        spotifyUrl: trackId
          ? `https://open.spotify.com/track/${trackId}`
          : undefined,
      });
    });

  tracks.sort((a, b) => a.rank - b.rank);

  if (tracks.length === 0) {
    throw new Error(
      `No weekly tracks could be parsed for ${country}`
    );
  }

  return tracks;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    const country = (
      searchParams.get('country') || 'global'
    )
      .trim()
      .toLowerCase();

    const requestedLimit = Number.parseInt(
      searchParams.get('limit') || '25',
      10
    );

    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 200))
      : 25;

    const requestedPeriod = (
      searchParams.get('period') || 'daily'
    )
      .trim()
      .toLowerCase();

    if (
      requestedPeriod !== 'daily' &&
      requestedPeriod !== 'weekly'
    ) {
      return NextResponse.json(
        {
          error: 'Unsupported chart period',
          supportedPeriods: ['daily', 'weekly'],
        },
        { status: 400 }
      );
    }

    const period = requestedPeriod as ChartPeriod;

    if (!SUPPORTED_COUNTRIES[country]) {
      return NextResponse.json(
        {
          error: 'Unsupported country',
          supportedCountries: Object.keys(
            SUPPORTED_COUNTRIES
          ),
        },
        { status: 400 }
      );
    }

    let rawTracks: ChartTrack[];

    if (period === 'weekly') {
      // Fetch the actual weekly chart from Kworb.
      rawTracks = await scrapeKworbWeeklyTracks(country);
    } else {
      // Preserve the existing daily scraping implementation.
      const dailyTracks =
        country === 'global'
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

    const search = (
      searchParams.get('search') ||
      searchParams.get('q') ||
      ''
    )
      .trim()
      .toLowerCase();

    const matchingTracks = search
      ? rawTracks.filter((track) =>
          `${track.trackName} ${track.artistName}`
            .toLowerCase()
            .includes(search)
        )
      : rawTracks;

    const selectedTracks = matchingTracks.slice(0, limit);

    const tracks = await Promise.all(
      selectedTracks.map(async (track) => {
        let imageUrl: string | undefined;
        let spotifyUrl = track.spotifyUrl;

        if (track.trackId) {
          try {
            const metadata = await resolveTrackOEmbed(
              track.trackId
            );

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

          previousRank: null,
          rankDelta: null,

          // Preserve the old daily field for compatibility.
          dailyStreams:
            period === 'daily' ? track.streams : null,

          weeklyStreams:
            period === 'weekly' ? track.streams : null,

          streams: track.streams,
          periodStreams: track.streams,

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
    console.error(
      'Direct Kworb chart request failed:',
      error
    );

    return NextResponse.json(
      {
        error: 'Failed to fetch Spotify charts',
        details:
          error instanceof Error
            ? error.message
            : 'Unknown error',
      },
      { status: 502 }
    );
  }
}
