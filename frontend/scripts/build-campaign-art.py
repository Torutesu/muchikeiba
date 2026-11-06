"""Original UI illustrations for the existing product IDs. No external imagery."""
from pathlib import Path
out=Path(__file__).resolve().parents[1]/'public/campaign/art';out.mkdir(parents=True,exist_ok=True)
for name,ink,pattern,title in [
 ('silks-lightning','#173f36','<path d="M70 26 50 67h18L54 104l40-51H74l16-27Z" fill="#e2c88e"/>','スターター勝負服・稲妻'),
 ('silks-flame','#753b38','<path d="M64 104c-23-8-17-24-10-32-3 13 5 14 5 14-2-20 17-20 9-43 25 22 7 33 11 40 5-3 8-9 7-15 16 20 5 35-22 36Z" fill="#e2c88e"/>','シーズン勝負服・炎'),
 ('silks-wings','#335e78','<path d="M64 54 37 43l4 13 15 7-17-3 7 12 12 2-12 2 10 9 8-8 8 8 10-9-12-2 12-2 7-12-17 3 15-7 4-13Z" fill="#f7f6f0"/>','ログイン勝負服・翼')]:
 body=f'<ellipse cx="64" cy="117" rx="40" ry="5" fill="#17372a" opacity=".09"/><path d="M48 18 29 24 13 46l18 17 10-11v60h46V52l10 11 18-17-16-22-19-6-16 8Z" fill="{ink}" stroke="#b39459" stroke-width="1.6"/>{pattern}<path d="M52 19q12 17 24 0M64 31v79" fill="none" stroke="#f7f6f0" stroke-opacity=".55" stroke-width="1.4"/>'
 (out/(name+'.svg')).write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><title>{title}</title>{body}</svg>')
(out/'ticket-sr.svg').write_text('''<svg xmlns="http://www.w3.org/2000/svg" width="160" height="128" viewBox="0 0 160 128"><title>SR以上スカウトチケット</title><defs><linearGradient id="foil" x2="1" y2="1"><stop stop-color="#e2c88e"/><stop offset="1" stop-color="#ae8b48"/></linearGradient></defs><ellipse cx="80" cy="111" rx="57" ry="5" fill="#17372a" opacity=".08"/><g transform="rotate(-12 80 64)"><path d="M19 30h122v25a9 9 0 0 0 0 18v25H19V73a9 9 0 0 0 0-18Z" fill="#173f36" stroke="url(#foil)" stroke-width="2"/><path d="M29 39h102v50H29Z" fill="none" stroke="#b39459" stroke-width=".7"/><path d="M48 46v36m64-36v36" stroke="#b39459" stroke-dasharray="2 3"/><path d="m80 46 5 12 13 6-13 6-5 12-5-12-13-6 13-6Z" fill="url(#foil)"/></g></svg>''')
print('Created 4 original campaign illustrations')
