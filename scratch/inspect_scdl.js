import scdl from 'soundcloud-downloader';

const instance = scdl.default;
let currentObj = instance;
const props = new Set();
do {
  Object.getOwnPropertyNames(currentObj).forEach(p => props.add(p));
} while ((currentObj = Object.getPrototypeOf(currentObj)));

console.log('All properties on scdl.default (including prototype):', Array.from(props));
