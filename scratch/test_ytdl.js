import execYoutubeDl from 'youtube-dl-exec';

const url = 'https://soundcloud.com/dasha-nabok/sets/plejlist';
console.log('Testing URL:', url);

const options = {};
const defaultFlags = {
    'no-warnings': true,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'no-check-certificates': true
};

async function test() {
    try {
        console.log('Executing yt-dlp...');
        const res = await execYoutubeDl(url, {
            ...defaultFlags,
            dumpSingleJson: true,
            flatPlaylist: true
        }, options);
        
        console.log('Result type:', typeof res);
        console.log('Result truthy:', !!res);
        if (res) {
            console.log('Result keys:', Object.keys(res));
            console.log('Result title:', res.title);
            console.log('Entries count:', res.entries ? res.entries.length : 'no entries');
        }
    } catch (e) {
        console.error('Error:', e);
        console.error('Stderr:', e.stderr);
    }
}

test();
