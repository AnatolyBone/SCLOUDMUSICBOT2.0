import axios from 'axios';

const urls = [
    'https://soundcloud.com/dasha-nabok/sets/plejlist',
    'https://soundcloud.com/dasha-nabok/sets/plejlist?si=d25fb20b8fca4a288478cbef1a1361c4' // mock si
];

async function test() {
    for (const url of urls) {
        try {
            console.log('Fetching:', url);
            const res = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            console.log('Status:', res.status);
            console.log('Content length:', res.data.length);
            console.log('Contains playlist tracks:', res.data.includes('tracks') || res.data.includes('Playlists'));
        } catch (e) {
            console.error('Error status:', e.response ? e.response.status : e.message);
        }
    }
}

test();
