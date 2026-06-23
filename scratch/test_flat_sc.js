import execYoutubeDl from 'youtube-dl-exec';
import { PROXY_URL } from '../config.js';

const url = 'https://soundcloud.com/dora-dura-825228440/sets/fors-treki-iz-tt-2026';

const defaultFlags = {
    'no-warnings': true,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'no-check-certificates': true,
    dumpSingleJson: true,
    flatPlaylist: true
};

async function test() {
    try {
        console.log('Fetching flat playlist metadata...');
        const res = await execYoutubeDl(url, defaultFlags);
        console.log('Success! Result title:', res.title);
        console.log('Entries count:', res.entries ? res.entries.length : 'no entries');
        if (res.entries && res.entries.length > 0) {
            console.log('First entry:', JSON.stringify(res.entries[0], null, 2));
        }
    } catch (e) {
        console.error('Error:', e);
    }
}

test();
