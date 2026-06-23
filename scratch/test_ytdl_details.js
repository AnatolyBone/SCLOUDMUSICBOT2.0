import execYoutubeDl from 'youtube-dl-exec';

const url = 'https://soundcloud.com/dasha-nabok/sets/plejlist';
console.log('execYoutubeDl keys:', Object.keys(execYoutubeDl));
console.log('execYoutubeDl toString:', execYoutubeDl.toString());

const defaultFlags = {
    'no-warnings': true,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'no-check-certificates': true
};

async function test() {
    try {
        console.log('Test 1: raw exec...');
        const promise = execYoutubeDl(url, {
            ...defaultFlags,
            dumpSingleJson: true,
            flatPlaylist: true
        });
        console.log('Promise class:', promise.constructor.name);
        const res = await promise;
        console.log('Resolved value:', res);
    } catch (e) {
        console.error('Error:', e);
    }
}

test();
