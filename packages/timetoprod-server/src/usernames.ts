/**
 * Funny username generator — agent-themed, memorable, unique.
 * Format: adjective-noun-number (like Reddit's auto-generated names)
 */

const ADJECTIVES = [
  'async', 'atomic', 'binary', 'blazing', 'cached', 'compiled',
  'concurrent', 'cryptic', 'daemon', 'deployed', 'dynamic', 'eager',
  'elastic', 'encrypted', 'ephemeral', 'forked', 'frozen', 'fuzzy',
  'greedy', 'hashed', 'headless', 'hyper', 'idle', 'inlined',
  'jitted', 'kinetic', 'lazy', 'linked', 'live', 'locked',
  'merged', 'minted', 'native', 'nested', 'null', 'optimal',
  'parallel', 'patched', 'piped', 'polled', 'queued', 'rapid',
  'reactive', 'recursive', 'remote', 'routed', 'runtime', 'scaled',
  'serial', 'sharded', 'silent', 'slick', 'snappy', 'spawned',
  'stacked', 'static', 'stealth', 'streamed', 'sudo', 'swift',
  'synced', 'threaded', 'turbo', 'typed', 'unboxed', 'virtual',
  'volatile', 'wired', 'yielded', 'zero',
];

const NOUNS = [
  'alpaca', 'badger', 'beetle', 'bison', 'bobcat', 'cobra',
  'condor', 'coyote', 'crane', 'crow', 'dingo', 'dolphin',
  'eagle', 'falcon', 'ferret', 'firefly', 'fox', 'gecko',
  'gopher', 'hawk', 'heron', 'hornet', 'hound', 'iguana',
  'jackal', 'jaguar', 'kestrel', 'koala', 'lemur', 'leopard',
  'lobster', 'lynx', 'mantis', 'marten', 'mongoose', 'moth',
  'narwhal', 'newt', 'octopus', 'orca', 'osprey', 'otter',
  'panther', 'parrot', 'pelican', 'penguin', 'phoenix', 'puma',
  'python', 'raven', 'robin', 'salmon', 'scorpion', 'shark',
  'sparrow', 'spider', 'squid', 'stork', 'swift', 'tiger',
  'toucan', 'viper', 'walrus', 'wasp', 'weasel', 'wolf',
  'wolverine', 'wren', 'yak', 'zebra',
];

export function generateUsername(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 900) + 100; // 100-999
  return `${adj}-${noun}-${num}`;
}
