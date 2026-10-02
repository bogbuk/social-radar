import type { Post } from './types';

// Синтетический пост для `POST /run?key=&sample=1`: проверка модели и Telegram без похода в Reddit.
export function samplePost(nowMs: number): Post {
  return {
    id: `sample-${Math.floor(nowMs / 1000)}`,
    subreddit: 'CDL',
    title: 'Does the 14 hour clock keep running while I wait at the shipper?',
    selftext:
      'New driver here. Sat at a shipper for 4 hours today and my dispatcher says I still have my full 11 to drive. ' +
      'Is that right or does the waiting eat into my hours of service? Trying to plan if I can make the delivery tonight.',
    url: 'https://www.reddit.com/r/CDL/comments/sample/does_the_14_hour_clock_keep_running/',
    createdUtc: Math.floor(nowMs / 1000) - 600,
    numComments: 2,
    author: 'sample_user',
  };
}
