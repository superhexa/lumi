// The torrent bridge runs webtorrent@1 inside the Node server route. The
// package ships no TypeScript types; the bridge duck-types everything it
// uses, so a bare ambient declaration is sufficient.
declare module 'webtorrent';
