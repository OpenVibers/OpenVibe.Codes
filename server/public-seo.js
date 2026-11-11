'use strict';
// Public metadata is applied to HTML and Markdown through the same layout.
const META = {
    '/': ['OpenVibe.Codes: code with any agent', 'Run coding agents with your own plans and keys. Start tasks from any browser, follow their work, and review the changes with OpenVibe Codes.'],
    '/start': ['Get started with coding agents', 'Install the OpenVibe Codes harness, connect your coding agents, and run tasks locally with permissions, hand-offs and a saved event stream.'],
    '/run': ['Run locally', 'Run coding agents locally from any browser. Connect your computer, describe a task, and watch your agents return a patch, branch or pull request.'],
    '/harnesses': ['The coding agents', 'Compare the coding agents available in OpenVibe Codes, including their models, capabilities, prices and limits, and learn how tasks are routed.'],
    '/skills': ['Skills for coding agents', 'Browse public skills, rules and MCP servers for coding agents. Version and sync them into Claude Code, Codex, OpenCode and Command Code.'],
    '/improve': ['Improve OpenVibe', 'Choose an open-source OpenVibe repository, describe a change, and use a coding agent on your computer to prepare a reviewed pull request.'],
    '/updates': ['What shipped', 'Read the OpenVibe Codes update log for changes to coding agents, local runs, the harness, skills and the browser workspace.'],
    '/policy': ['Community', 'Read the OpenVibe contributor guides and community policies, including the code of conduct, contributor ladder and moderation process.'],
};
function metadata(path, o) {
    const fixed = META[path];
    const title = fixed ? fixed[0] : String(o.title || 'OpenVibe Codes').slice(0, 43);
    const description = fixed ? fixed[1] : String(o.description || `${o.title}: contributor guidance and community policy for OpenVibe Codes and its open-source repositories.`).slice(0, 155);
    return { title, description };
}
function structuredData(path, o, canonical) {
    const nodes = [...(o.jsonLd || [])];
    if (path !== '/') nodes.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'OpenVibe Codes', item: `${o.config.baseUrl}/` },
        ...(o.crumbs || []).filter(c => c.href).map((c, i) => ({ '@type': 'ListItem', position: i + 2, name: c.label, item: new URL(c.href, o.config.baseUrl).href })),
        { '@type': 'ListItem', name: o.title, item: canonical },
    ].map((item, i) => ({ ...item, position: i + 1 })) });
    const steps = path === '/run' ? [
        ['Add your computer', 'Pair your computer at openvibe.my/#machines: one command, which installs OpenVibe Link with its job worker.'],
        ['Describe the task', 'Sign in here and describe the task.'],
        ['Get the result', 'Your machine clones the repository, runs the agent and sends the result back.'],
    ] : path === '/start' ? [
        ['Install', 'Install Node.js 22 or newer, then install openvibe-codes with the command shown on this page.'],
        ['The agents it can use', 'Install any of the listed agents; the harness uses what is there and says why the rest are not.'],
        ['Use it', 'Run openvibe-codes run with your task. The exit code follows the result: 0 when the last agent finished, 1 when it did not.'],
    ] : null;
    if (steps) nodes.push({ '@context': 'https://schema.org', '@type': 'HowTo', name: o.title, url: canonical,
        step: steps.map(([name, text], i) => ({ '@type': 'HowToStep', position: i + 1, name, text })) });
    return nodes;
}
module.exports = { META, metadata, structuredData };
