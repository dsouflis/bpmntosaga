const jp = require("jsonpath");
let xml2js = require('xml2js');

var parser = new xml2js.Parser({explicitArray: false, trim: true});
const {parseScript} = require("shift-parser");

const findTextAnnotationForId = (id, diagram) => {
  var associations = diagram["bpmn:definitions"]["bpmn:process"]["bpmn:association"];
  if (!(associations instanceof Array)) {
    associations = [associations];
  }
  let foundAssociation = jp.query(associations, `$[?(@.$.sourceRef == "${id}")]`);
  if (!foundAssociation.length) {
    return null;
  }
  const annotationId = foundAssociation[0].$.targetRef;
  var textAnnotations = diagram["bpmn:definitions"]["bpmn:process"]["bpmn:textAnnotation"];
  if (!(textAnnotations instanceof Array)) {
    textAnnotations = [textAnnotations];
  }
  let foundTextAnnotation = jp.query(textAnnotations, `$[?(@.$.id == "${annotationId}")]`);
  if (!foundTextAnnotation.length) {
    return null;
  }
  return foundTextAnnotation[0]["bpmn:text"];
};

const readCustomElements = (obj) => {
  switch (obj.kind) {
    case 'bpmn:startEvent':
    case 'bpmn:endEvent':
      if (obj['bpmn:messageEventDefinition'] && obj.$['custom:actionType']) {
        return obj.$['custom:actionType'];
      }
      break;
    case 'bpmn:exclusiveGateway':
      if (obj.$['custom:condition']) {
        return obj.$['custom:condition'];
      }
      break;
    case 'bpmn:task':
      if (obj['custom:call']) {
        return obj['custom:call'];
      }
      break;
    case 'bpmn:serviceTask':
      if (obj['custom:script']) {
        return obj['custom:script'];
      }
      break;
    default:
      return null;
  }
};

const addTextAnnotation = (obj, diagram) => {
  const { id } = obj.$;
  const res = readCustomElements(obj) || findTextAnnotationForId(id, diagram);
  obj.text = res;
};

const addOutgoing = (obj, diagram) => {
  var outgoing = obj["bpmn:outgoing"];
  obj.outgoing = [];
  if (!outgoing) {
    return;
  }
  const sf = diagram["bpmn:definitions"]["bpmn:process"]["bpmn:sequenceFlow"];
  const flows = (sf instanceof Array) ? sf : [sf];
  if (!(outgoing instanceof Array)) {
    outgoing = [outgoing];
  }
  outgoing.forEach(outgoingId => {
    const res = flows.filter(o => o.$ && o.$.id === outgoingId);
    if (!res.length) {
      console.log(`No flow found for ${outgoingId}`);
    } else {
      if(outgoingId === obj.$.default) {
        obj.default = res[0].$.targetRef;
      } else {
        obj.outgoing.push(res[0].$.targetRef);
      }
    }
  });
};

const codeForNode = (e) => {
  if (e.kind === 'bpmn:exclusiveGateway' && e.default) {
    return `  if(!(${e.text})) {
    yield* ${e.default}(context);
    return;
  }`;
  } else if (e.kind === 'bpmn:exclusiveGateway') {
    return `  if(!(${e.text})) return;`;
  } else if (e.kind === 'bpmn:task' && e.default) {
    return `
  try {
    context['${e.$.name}'] = yield ${e.text};
  } catch(e) {
    context['${e.$.name}'] = e;
    yield* ${e.default}(context);
  }`;
  } else if (e.kind === 'bpmn:serviceTask' && e.default) {
    return `
  try {
    ${e.text};
  } catch(e) {
    context['${e.$.name}'] = e;
    yield* ${e.default}(context);
  }`;
  } else if (e.kind === 'bpmn:task') {
    return `  context['${e.$.name}'] = yield ${e.text};`;
  } else if (e.kind === 'bpmn:serviceTask') {
    return `  ${e.text};`;
  } else if (e.kind === 'bpmn:endEvent' && e['bpmn:messageEventDefinition']) {
    return `  yield put(${e.text});`;
  } else {
    return `  //....${e.kind}`;
  }
}

const diagramToSaga = async (diagram) => {
  var saga = '';
  const parsed = await parser.parseStringPromise(diagram);

  // console.log(JSON.stringify(parsed, null, 2));
  saga += (`import { call, put, take, takeEvery, takeLatest, spawn, select } from 'redux-saga/effects';\nimport axios from 'axios';\n`);

  Object.entries(parsed["bpmn:definitions"]["bpmn:process"]).forEach(
      ([key, value]) => {
        if (
            [
              "$",
              "bpmn:sequenceFlow",
              "bpmn:textAnnotation",
              "bpmn:association",
            ].includes(key)
        ) {
          return;
        }
        const array = value instanceof Array ? value : [value];
        array.forEach(e => {
          e.kind = key;
          addTextAnnotation(e, parsed);
          addOutgoing(e, parsed);
          if (key === "bpmn:task" && e.text) {
            try {
              // eslint-disable-next-line no-unused-vars
              const ast = parseScript(e.text);
              ast.statements.forEach(st => {
                if (
                    st.type === "ExpressionStatement" &&
                    st.expression.type === "CallExpression" &&
                    st.expression.callee.type === "IdentifierExpression" &&
                    st.expression.callee.name === "call" &&
                    st.expression.arguments[0].type === "StaticMemberExpression" &&
                    st.expression.arguments[0].object.type ===
                    "IdentifierExpression"
                ) {
                  const api = st.expression.arguments[0].object.name;
                  // const meth = st.expression.arguments[0].property;
                  saga += `import ${api} from 'apis/${api}';\n`;
                }
              });
            } catch (ex) {
              // should have been caught by checker
            }
          }
        });
      }
  );

  // console.log(JSON.stringify(parsed["bpmn:definitions"]["bpmn:process"], null, 2));

  const startEvent = parsed["bpmn:definitions"]["bpmn:process"]["bpmn:startEvent"];
  if (startEvent instanceof Array) {
    console.log('Error: Multiple start events!');
    return '';
  } else {
    saga += (`
function* saga () {
  yield* ${startEvent.$.id}({});
}\n`);
  }

  Object.entries(parsed["bpmn:definitions"]["bpmn:process"]).forEach(([key, value]) => {
    if (['$', 'bpmn:sequenceFlow', 'bpmn:textAnnotation', 'bpmn:association'].includes(key)) {
      return;
    }
    const array = (value instanceof Array) ? value : [value];
    array.forEach(e => {
      const cont = e.outgoing.length === 1 ?
          `  yield* ${e.outgoing[0]}(context);` :
          e.outgoing.map(id => `  yield spawn(${id}, context);`).join('\n');
      if (e.kind === 'bpmn:startEvent' && e["bpmn:messageEventDefinition"]) {
        saga += (`
function* ${e.$.id} (context) {
  yield takeEvery('${e.text}', ${e.$.id}_fork, context);
}

function* ${e.$.id}_fork (context, action) {
  context['${e.$.name}'] = action;
${cont}
}\n`);

      } else {
        const code = codeForNode(e);
        saga += (`
function* ${e.$.id} (context) {
${code}
${cont}
}\n`);
      }
    });
  });

  saga += ('export default saga;\n');

  return saga;
};

const actionTagRegex = /^@[\w-]+\/[\w_]+$/;
const checkStartMessageEventText = text => {
  return actionTagRegex.test(text);
};

const checkdiagram = async (diagram) => {
  const parsed = await parser.parseStringPromise(diagram);

  for (const [key, value] of Object.entries(parsed["bpmn:definitions"]["bpmn:process"])) {
    if (['$', 'bpmn:sequenceFlow', 'bpmn:textAnnotation', 'bpmn:association'].includes(key)) {
      continue;
    }
    const array = (value instanceof Array) ? value : [value];
    for (const e of array) {
      e.kind = key;
      addTextAnnotation(e, parsed);
      addOutgoing(e, parsed);
      if (
          (!e.text || !e.text.length) &&
          (!["bpmn:endEvent", "bpmn:startEvent"].includes(e.kind) ||
              e["bpmn:messageEventDefinition"])
      ) {
        return {outcome: false, reason: `${e.$.id} has no text annotation`};
      }
      var jsText;
      if (e.kind === 'bpmn:exclusiveGateway') {
        jsText = `if(${e.text}) x = 1`;
      } else if (e.kind === 'bpmn:task' || e.kind === 'bpmn:serviceTask') {
        jsText = e.text;
      } else if (e.kind === 'bpmn:endEvent' && e['bpmn:messageEventDefinition']) {
        jsText = `x = (${e.text})`;
      }
      if (jsText) {
        try {
          const ast = parseScript(jsText);
        } catch (ex) {
          return {outcome: false, reason: `${e.$.id} : ${ex}`};
        }
      }
    }
  }

  const startEvent = parsed["bpmn:definitions"]["bpmn:process"]["bpmn:startEvent"];
  if (startEvent instanceof Array) {
    return {outcome: false, reason: "multiple start events"};
  }
  if (startEvent["bpmn:messageEventDefinition"]) {
    if (!startEvent.text || !startEvent.text.length) {
      return {outcome: false, reason: "message start event has no action type definition"};
    }
    if (!checkStartMessageEventText(startEvent.text)) {
      return {outcome: false, reason: "message start event has incorrect action type definition"};
    }
  }

  Object.entries(parsed["bpmn:definitions"]["bpmn:process"]).forEach(([key, value]) => {
    if (['$', 'bpmn:sequenceFlow', 'bpmn:textAnnotation', 'bpmn:association', 'bpmn:startEvent'].includes(key)) {
      return;
    }
    const array = (value instanceof Array) ? value : [value];
    array.forEach(e => {
      addTextAnnotation(e, parsed);
      addOutgoing(e, parsed);
    });
  });

  return {outcome: true};
};

module.exports = {
  diagramToSaga,
  checkdiagram
};
