import { createHash } from 'node:crypto';
import type { QualifiedScriptId } from '../../shared/types/qualified-userscripts';

export interface CatalogAsset {
  readonly key: string;
  readonly kind: 'source' | 'require' | 'resource';
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface CatalogEntry {
  readonly id: QualifiedScriptId;
  readonly name: string;
  readonly version: string;
  readonly runAt: 'document-start' | 'document-end';
  readonly matches: readonly string[];
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
  /** Source first, followed by requires and named resources in declaration order. */
  readonly assets: readonly CatalogAsset[];
}

export const QUALIFIED_SCRIPT_CATALOG = {
  'ac-baidu': {
    id: 'ac-baidu',
    name: 'AC-baidu-重定向优化百度搜狗谷歌必应搜索_favicon_双列',
    version: '27.20',
    runAt: 'document-start',
    matches: [],
    includes: [
      '*://ipv6.baidu.com/*',
      '*://www.baidu.com/*',
      '*://www1.baidu.com/*',
      '*://m.baidu.com/*',
      '*://xueshu.baidu.com/s*',
      '*://www.so.com/s?*',
      '*://*.bing.com/*',
      '*://encrypted.google.*/search*',
      '*://*.google*/search*',
      '*://scholar.google.com/scholar*',
      '*://*.google*/webhp*',
      '*://*duckduckgo.com/*',
      '*://*.dogedoge.com/*',
      '*://*.90dao.com/*',
      '*://*.tujidu.com/*',
      '*://localhost*/*',
    ],
    excludes: [
      '*://*.google*/sorry*',
      'https://zhidao.baidu.com/*',
      'https://*.zhidao.baidu.com/*',
      'https://www.baidu.com/img/*',
      'https://lens.google.com/*',
    ],
    assets: [
      {
        key: 'source',
        kind: 'source',
        url: 'https://update.greasyfork.org/scripts/14178/AC-baidu-%E9%87%8D%E5%AE%9A%E5%90%91%E4%BC%98%E5%8C%96%E7%99%BE%E5%BA%A6%E6%90%9C%E7%8B%97%E8%B0%B7%E6%AD%8C%E5%BF%85%E5%BA%94%E6%90%9C%E7%B4%A2_favicon_%E5%8F%8C%E5%88%97.user.js',
        sha256: '7BD4AA93736B807028384BB22350B776190024B2C72A3D044A2E04E64B7DEAD4',
        bytes: 129862,
      },
      {
        key: 'require-0',
        kind: 'require',
        url: 'https://registry.npmmirror.com/less_browser_fix/4.2.2/files/dist/less.min.js',
        sha256: 'EA220AF1C3F9C6BF4B99E1E7D4FD083B8B53C3774E807ADE730623E83D17B84F',
        bytes: 153816,
      },
      {
        key: 'require-1',
        kind: 'require',
        url: 'https://registry.npmmirror.com/vue/3.5.26/files/dist/vue.runtime.global.prod.js',
        sha256: '788109BEE7B1AA7904880B5917FD581270DFE178E11DFB77E6F35DCCBF49E40E',
        bytes: 103186,
      },
      {
        key: 'baiduCommonStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/baiduCommonStyle.less?t=27.20',
        sha256: '36C1397AA5D5B16EDE93E93776DAE8A6FB57C392D53FDF691139997A5D3F6656',
        bytes: 10711,
      },
      {
        key: 'baiduOnePageStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/baiduOnePageStyle.less?t=27.20',
        sha256: '5C3F2FED34A303B16217F0D341C5CCD4FAE8FC910F93A408646A0374A799DFF2',
        bytes: 5750,
      },
      {
        key: 'baiduTwoPageStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/baiduTwoPageStyle.less?t=27.20',
        sha256: '2FF7762279883BED43F837DA80773C0839F5579AA35F6377E80721F6F6D3F90C',
        bytes: 4488,
      },
      {
        key: 'googleCommonStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/googleCommonStyle.less?t=27.20',
        sha256: '96CEC95974FDB284203A26D9F38F0141BB4149AA834663F9FDE9783FF2FAE0F1',
        bytes: 8369,
      },
      {
        key: 'googleOnePageStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/googleOnePageStyle.less?t=27.20',
        sha256: 'ED02438C876A7781D5CFEF08ECB2A1D3AFF487F4F40884317F6300821CEA3FEA',
        bytes: 2542,
      },
      {
        key: 'googleTwoPageStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/googleTwoPageStyle.less?t=27.20',
        sha256: '652DD4A1D92209A5473AE7617BD22FF5DB9B7AD192D524DBF8C0AF889380D3BC',
        bytes: 2059,
      },
      {
        key: 'bingCommonStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/bingCommonStyle.less?t=27.20',
        sha256: '2C5B285B4B3BCE02020CD15517C6130AB5D7273E8CCBA1E5A281F75733889B16',
        bytes: 4904,
      },
      {
        key: 'bingOnePageStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/bingOnePageStyle.less?t=27.20',
        sha256: '41440D473818A9BA8943FFA805C7D6D6545EEB71DEF88850B716A0795FEA0860',
        bytes: 610,
      },
      {
        key: 'bingTwoPageStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/bingTwoPageStyle.less?t=27.20',
        sha256: '1746026D5769007113C47347C31E5810558084D0BFFF3A7A4BD63CBE07A8A36E',
        bytes: 1138,
      },
      {
        key: 'duckCommonStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/duckCommonStyle.less?t=27.20',
        sha256: '1B34C3B5CDE61B2B9372A7EE837F21B4AB5A5F4D71B2180FFD9E907A196C72CA',
        bytes: 2330,
      },
      {
        key: 'duckOnePageStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/duckOnePageStyle.less?t=27.20',
        sha256: '14C662441F25D9C362390D2AC00E23FF3D0EFE9FE727A2C88AAD242436064E67',
        bytes: 806,
      },
      {
        key: 'duckTwoPageStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/duckTwoPageStyle.less?t=27.20',
        sha256: '609A11DECE6AFDC88A5C0F3E16A25924FAC990EAB990F7035EE354E07A5B79A1',
        bytes: 1303,
      },
      {
        key: 'dogeCommonStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/dogeCommonStyle.less?t=27.20',
        sha256: '65EADCCFE43AC24349291EF07A6BBDE908238DE7EA032B2883B008EFCFA1A4DA',
        bytes: 2435,
      },
      {
        key: 'dogeOnePageStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/dogeOnePageStyle.less?t=27.20',
        sha256: '9E0F32087DFD8FE40606C462A4D31BD06751833776CFF689B6CB46534F45DD5B',
        bytes: 1002,
      },
      {
        key: 'dogeTwoPageStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/dogeTwoPageStyle.less?t=27.20',
        sha256: '07EDD3A5383FA35C5E6F68A8F24CECF882A9BADC92DBBE7111D2C9DE9C72015E',
        bytes: 1430,
      },
      {
        key: 'haosouCommonStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/haosouCommonStyle.less?t=27.20',
        sha256: 'C91828D49D371F2BA2EC2F50FDE5D33682F31CC85D0019ECD89172960BBFDFC2',
        bytes: 639,
      },
      {
        key: 'haosouOnePageStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/haosouOnePageStyle.less?t=27.20',
        sha256: '72C7F69B877D213BE44BDC76147543E2D4848E1D5AD28EF7A8471900E09FCD06',
        bytes: 884,
      },
      {
        key: 'haosouTwoPageStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/haosouTwoPageStyle.less?t=27.20',
        sha256: '052ADCFE7DFD16697ABDD685C1AFC8467A6CDF4B5D1ACCEA20FA98BDA44950D0',
        bytes: 969,
      },
      {
        key: 'HuYanStyle',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/HuYanStyle.less?t=27.20',
        sha256: '1CBEB5D0A0D1155374C28DCDF2BE3DCEEB527F8AEB95E9D035D9F9DF94C62099',
        bytes: 2550,
      },
      {
        key: 'BgAutoFit',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/BgAutoFit.less?t=27.20',
        sha256: '7356CED5E26E4DB6F7E31EBE8B09831066E00AE92D94806629A06C0E43343167',
        bytes: 2567,
      },
      {
        key: 'HuaHua-ACDrakMode',
        kind: 'resource',
        url: 'https://ibaidu.tujidu.com/newcss/HuaHua-ACDrakMode.less?t=27.20',
        sha256: '395A3381966FBED8899C713163EAE3263DC969EFBC5022B074B82E2F3D2AC458',
        bytes: 5221,
      },
      {
        key: 'baiduLiteStyle',
        kind: 'resource',
        url: 'https://gitcode.net/-/snippets/1906/raw/master/LiteStyle.css?inline=false',
        sha256: '215B824DD21975BB5C50266BBBE850038BE2273D4B4DC8EE1DCD3A6601E7C2A9',
        bytes: 60234,
      },
    ],
  },
  'github-zh': {
    id: 'github-zh',
    name: 'GitHub 中文化插件',
    version: '1.9.2.4-2026-09-27',
    runAt: 'document-end',
    matches: [
      'https://github.com/*',
      'https://skills.github.com/*',
      'https://gist.github.com/*',
      'https://www.githubstatus.com/*',
    ],
    includes: [],
    excludes: [],
    assets: [
      {
        key: 'source',
        kind: 'source',
        url: 'https://update.greasyfork.org/scripts/435208/GitHub%20%E4%B8%AD%E6%96%87%E5%8C%96%E6%8F%92%E4%BB%B6.user.js',
        sha256: 'D757CBFF1FE100D59C4927047782C3D2C59A124C57481EAAD5CF8D864DDBB2DB',
        bytes: 35789,
      },
      {
        key: 'require-0',
        kind: 'require',
        url: 'https://greasyfork.org/scripts/435207-github-%E4%B8%AD%E6%96%87%E5%8C%96%E6%8F%92%E4%BB%B6-%E4%B8%AD%E6%96%87%E8%AF%8D%E5%BA%93%E8%A7%84%E5%88%99/code/GitHub%20%E4%B8%AD%E6%96%87%E5%8C%96%E6%8F%92%E4%BB%B6%20-%20%E4%B8%AD%E6%96%87%E8%AF%8D%E5%BA%93%E8%A7%84%E5%88%99.js?v1.9.2.4-2026-09-27',
        sha256: 'E0830A78AC89B26358E7B6CB1BD4323DB56F362E92363D4B8EE691C84A26AF08',
        bytes: 1992540,
      },
    ],
  },
} as const satisfies Record<QualifiedScriptId, CatalogEntry>;

export function getCatalogEntry(id: QualifiedScriptId): CatalogEntry {
  return QUALIFIED_SCRIPT_CATALOG[id];
}

export function matchesCatalogRootSource(
  id: QualifiedScriptId,
  source: string | Uint8Array,
): boolean {
  const root = QUALIFIED_SCRIPT_CATALOG[id].assets[0];
  if (root.kind !== 'source') return false;
  const bytes = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
  return (
    bytes.byteLength === root.bytes &&
    createHash('sha256').update(bytes).digest('hex').toUpperCase() === root.sha256
  );
}
