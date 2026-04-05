# Forge automation action add comment

Forge automation action is currently in EAP, see the [documentation](https://developer.atlassian.com/platform/forge/manifest-reference/modules/automation-action/) for more details.

This project contains a Forge app written in Javascript that adds a new custom action in Automation that can be used to add a Jira comment.

See [developer.atlassian.com/platform/forge/](https://developer.atlassian.com/platform/forge) for documentation and tutorials explaining Forge.

## Requirements

See [Set up Forge](https://developer.atlassian.com/platform/forge/set-up-forge/) for instructions to get set up.

## Quick start

- Modify your app actions by editing the `src/actions/index.js` file.

- Modify your app backend by editing the `src/resolvers/index.js` file to define resolver functions. See [Forge resolvers](https://developer.atlassian.com/platform/forge/runtime-reference/custom-ui-resolver/) for documentation on resolver functions.

- Install dependencies (inside of the root directory):

```sh
npm install
```

- Install dependencies (inside of the `static/hello-world` directory):

```sh
npm install
```

- Modify your app by editing the files in `static/hello-world/src/`.

- Build your app (inside of the `static/hello-world` directory):

```sh
npm run build
```

- Build and deploy your app by running:

```sh
forge deploy
```

- Install your app in an Atlassian site by running:

```sh
forge install
```

- Develop your app by running `forge tunnel` to proxy invocations locally:

```sh
forge tunnel
```

### Notes

- Use the `forge deploy` command when you want to persist code changes.
- Use the `forge install` command when you want to install the app on a new site.
- Once the app is installed on a site, the site picks up the new app changes you deploy without needing to rerun the install command.

## Support

See [Get help](https://developer.atlassian.com/platform/forge/get-help/) for how to get help and provide feedback.
