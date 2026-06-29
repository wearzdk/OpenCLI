import { cli, Strategy } from '@jackwener/opencli/registry';
import { getWordpressConfig, wpRequest } from './shared.js';

cli({
    site: 'wordpress',
    name: 'whoami',
    access: 'read',
    description: 'Verify the WordPress connection by fetching the authenticated user (GET /wp/v2/users/me). Use this to test that the site URL and Application Password are valid before publishing.',
    domain: 'wordpress.org',
    strategy: Strategy.LOCAL,
    browser: false,
    columns: ['id', 'name', 'slug', 'site'],
    func: async () => {
        const config = getWordpressConfig();
        const me = await wpRequest(config, '/wp/v2/users/me?context=edit', {
            label: 'WordPress whoami',
        });
        return [
            {
                id: me?.id ?? '',
                name: me?.name ?? '',
                slug: me?.slug ?? '',
                site: config.baseUrl,
            },
        ];
    },
});
