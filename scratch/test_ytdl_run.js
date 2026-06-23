import execYoutubeDl from 'youtube-dl-exec';

const url = 'https://soundcloud.com/dasha-nabok/sets/plejlist';
console.log('Running exec...');

const defaultFlags = {
    'no-warnings': true,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'no-check-certificates': true,
    dumpSingleJson: true,
    flatPlaylist: true
};

async function test() {
    const cp = execYoutubeDl.exec(url, defaultFlags);
    
    let stdout = '';
    let stderr = '';
    
    cp.stdout.on('data', data => {
        stdout += data.toString();
    });
    
    cp.stderr.on('data', data => {
        stderr += data.toString();
    });
    
    cp.on('close', code => {
        console.log('Exit code:', code);
        console.log('Stdout length:', stdout.length);
        console.log('Stderr length:', stderr.length);
        console.log('Stdout:', stdout);
        console.log('Stderr:', stderr);
    });
}

test();
