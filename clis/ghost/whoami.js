import { cli, Strategy } from '@jackwener/opencli/registry';
import { getGhostConfig, ghostRequest } from './shared.js';

cli({
    site: 'ghost',
    name: 'whoami',
    access: 'read',
    description: 'Verify the Ghost connection by fetching site info (GET /ghost/api/admin/site). Use this to test that the site URL and Admin API key are valid before publishing.',
    domain: 'ghost.org',
    strategy: Strategy.LOCAL,
    browser: false,
    columns: ['title', 'version', 'site'],
    func: async () => {
        const config = getGhostConfig();
        const data = await ghostRequest(config, '/site/', { label: 'Ghost whoami' });
        const site = data?.site ?? {};
        return [
            {
                title: site.title ?? '',
                version: site.version ?? '',
                site: site.url ?? config.baseUrl,
            },
        ];
    },
});
