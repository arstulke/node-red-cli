const path = require('path');

const {
  readFileAsync,
  writeFileAsync,
  httpRequest,
  toUrlEncoded,
  resolvePath
} = require('./utils');


async function loadConfigFile(_projectId, args, stageRequired) {
  const projectId = args.project;

  //TODO auto detect config.json files
  const projectFilePromise = readFileAsync(resolvePath('project.json'));
  const credentialsFilePromise = readFileAsync(resolvePath('credentials.json'));

  const projectFile = JSON.parse(await projectFilePromise);
  const projectFlowConfig = projectFile[projectId];
  const flowConfigFilePromise = readFileAsync(resolvePath(projectFlowConfig.directory, 'config.json'));
  const flowConfigFile = JSON.parse(await flowConfigFilePromise);

  flowConfigFile.directory = projectFlowConfig.directory;
  flowConfigFile.flowFile = resolvePath(projectFlowConfig.directory, flowConfigFile.flowFile);
  flowConfigFile.projectId = projectId;

  const credentialsFile = JSON.parse(await credentialsFilePromise);

  if (stageRequired && args.stage === undefined) {
    throw `Stage arg is for this script required but its value is '${args.stage}'.`;
  }

  if (stageRequired) {
    const stageKey = args.stage;
    const serverId = flowConfigFile.stages[stageKey];
    const secretServerConfig = credentialsFile[serverId];//TODO store password base64 encrypted in memory, read base64 from credentials.json
    const secretProjectConfig =
      secretServerConfig.projects && secretServerConfig.projects[projectId] !== undefined ?
      secretServerConfig.projects[projectId] : {};

    secretServerConfig.projects = undefined;

    const writeProtected = {
      stageId: stageKey,
      serverId: serverId
    };
    Object.assign(
      flowConfigFile,
      secretServerConfig,
      secretProjectConfig,
      writeProtected);
  }

  return flowConfigFile;
}

async function getToken(stageConfig) {
  if (stageConfig.username !== undefined && stageConfig.password !== undefined) {
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded"
    };
    let data = {
      'client_id': 'node-red-editor',
      'grant_type': 'password',
      'scope': '',
      'username': stageConfig.username,
      'password': stageConfig.password
    };
    data = toUrlEncoded(data);

    const res = await httpRequest('POST', stageConfig.url + '/auth/token', headers, data);
    const body = await res.json();
    const token = body.access_token;

    stageConfig.token = token;
    return {
      token
    };
  }
  return {
    token: undefined
  };
}

async function revokeToken(stageConfig) {
  const token = stageConfig.token;

  if (token) {
    const headers = {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    };
    const data = {
      token: token
    };
    const res = await httpRequest('POST', stageConfig.url + '/auth/revoke', Object.assign({}, headers), data);
    if (res.status !== 200) {
      throw `Revoke token didn't worked.`
    }
  }
  return {
    token: undefined
  };
}

function getNode(flowFileContent, predicate) {
  const matchingNodes = flowFileContent.nodes.filter(predicate);
  if (matchingNodes.length === 0) {
    throw `Unknown node`;
  } else if (matchingNodes.length > 1) {
    throw `Multiple nodes found`;
  } else {
    return matchingNodes[0];
  }
}

function getFunctionNode(flowFileContent, functionId) {
  const predicate = (node) => node.name && node.name.startsWith(functionId + ':');
  const node = getNode(flowFileContent, predicate);
  if (node.type === 'function') {
    return node;
  } else {
    throw `Node is not of type 'function'`;
  }
}

function getFlowSearchRegex(stageConfig) {
  const regexAsString = `sub-?project-?id:\\s*("|')${stageConfig.flowTextId}("|')`
  return new RegExp(regexAsString, "gi");
}

async function getFlowId(stageConfig) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + stageConfig.token,
    'Node-RED-API-Version': 'v2'
  };
  const flowsRes = await httpRequest('GET', stageConfig.url + '/flows', headers);
  let flows = (await flowsRes.json()).flows;

  const regex = getFlowSearchRegex(stageConfig);
  flows = flows.filter((node) => {
    return node.type && node.type === 'tab' && node.info && regex.test(node.info);
  });

  if (flows.length === 0) {
    throw `No flow with infoId '${stageConfig.flowTextId}' found.`;
  } else if (flows.length > 1) {
    throw `Multiple flows with infoId '${stageConfig.flowTextId}' found.`;
  }

  const flowId = flows[0].id;
  stageConfig.flowId = flowId;
  return flowId;
}

async function getFlow(stageConfig) {
  const flowId = await getFlowId(stageConfig);
  const headers = {
    'Authorization': 'Bearer ' + stageConfig.token
  };
  const res = await httpRequest('GET', stageConfig.url + '/flow/' + flowId, headers, null);
  if (res.status === 404) {
    throw `Flow with id ${flowId} not found.`;
  }
  return await res.json();
}

module.exports.loadConfigFile = loadConfigFile;
module.exports.getToken = getToken;
module.exports.revokeToken = revokeToken;

module.exports.getNode = getNode;
module.exports.getFunctionNode = getFunctionNode;
module.exports.getFlowSearchRegex = getFlowSearchRegex;
module.exports.getFlowId = getFlowId;
module.exports.getFlow = getFlow;