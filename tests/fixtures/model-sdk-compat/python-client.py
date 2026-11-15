"""Customer-style SDK calls. Emits bounded facts only, never model/error text."""
import os, sys, json, math, re, importlib.metadata
assert getattr(sys, '_sdk_tripwire_active', False), 'tripwire must load first'
LIB = os.environ['LIBRARY']; SCENARIO = os.environ['SCENARIO']; BASE = os.environ['BASE_URL']
KEY = os.environ['MODEL_DUMMY_KEY']; MODE = os.environ.get('MODE', '')
STREAM = SCENARIO == 'stream'; TOOL = SCENARIO == 'tool' or MODE == 'bad_tool_json'
PROMPT = 'compat-tool' if TOOL else 'compat-text'
SCHEMA = {'type':'object','properties':{'city':{'type':'string'}},'required':['city']}
R = dict(library=LIB,version=importlib.metadata.version(LIB),scenario=SCENARIO,outcome='parsed',errorClass='none',raisedIn='none',finish='none',toolArgsParse='na',textSeen=False,usageSeen=False,vectorLength=0,status=0,secondTurn=False,messageSeen=False)
stage='setup'
def finish(x):
    if x is not None:
        value = str(getattr(x,'value',x))
        R['finish'] = value if re.fullmatch(r'[A-Za-z0-9_:-]{1,60}',value) else 'other'
def args(x):
    if isinstance(x,str):
        try: x=json.loads(x)
        except (ValueError,TypeError): R['toolArgsParse']='invalid'; return
    R['toolArgsParse']='valid' if isinstance(x,dict) and isinstance(x.get('city'),str) else 'schema_invalid'
def vector(v):
    assert all(isinstance(x,(int,float)) and math.isfinite(x) for x in v)
    R['vectorLength']=len(v)
def run_openai():
    from openai import OpenAI
    client=OpenAI(api_key=KEY,base_url=BASE,timeout=20)
    if SCENARIO=='embeddings':
        r=client.embeddings.create(model='embed-test',input=['compat-text'],dimensions=8,encoding_format='float'); vector(r.data[0].embedding); R['usageSeen']=r.usage.total_tokens>=0; return
    kw=dict(model='gpt-test',messages=[{'role':'user','content':PROMPT}])
    if TOOL: kw['tools']=[{'type':'function','function':{'name':'weather','parameters':SCHEMA}}]
    if STREAM:
        accumulated=''
        with client.chat.completions.stream(**kw,stream_options={'include_usage':True}) as stream:
            for event in stream:
                if event.type != 'chunk': continue
                chunk=event.chunk
                if chunk.usage: R['usageSeen']=chunk.usage.total_tokens>=0
                for choice in chunk.choices:
                    R['textSeen'] |= bool(choice.delta.content or choice.delta.refusal); finish(choice.finish_reason)
                    for tc in choice.delta.tool_calls or []: accumulated += tc.function.arguments or ''
            final=stream.get_final_completion()
            R['usageSeen'] |= final.usage is not None
        if TOOL: args(accumulated)
    else:
        r=client.chat.completions.create(**kw); c=r.choices[0]; R['textSeen']=bool(c.message.content or c.message.refusal); finish(c.finish_reason); R['usageSeen']=r.usage is not None and r.usage.total_tokens>=0
        if TOOL:
            tc=c.message.tool_calls[0]; args(tc.function.arguments)
            if SCENARIO=='tool':
                kw['messages'] += [c.message.model_dump(exclude_none=True),{'role':'tool','tool_call_id':tc.id,'content':'sunny'}]
                rr=client.chat.completions.create(**kw); R['secondTurn']=bool(rr.choices[0].message.content)
    client.close()
def run_anthropic():
    from anthropic import Anthropic
    client=Anthropic(api_key=KEY,base_url=BASE.removesuffix('/v1'),timeout=20)
    kw=dict(model='claude-test',max_tokens=100,messages=[{'role':'user','content':PROMPT}])
    if TOOL: kw['tools']=[{'name':'weather','input_schema':SCHEMA}]
    if STREAM:
        with client.messages.stream(**kw) as stream:
            for text in stream.text_stream: R['textSeen'] |= bool(text)
            r=stream.get_final_message()
    else: r=client.messages.create(**kw)
    finish(r.stop_reason); R['usageSeen']=r.usage.input_tokens>=0 and r.usage.output_tokens>=0
    for block in r.content:
        if block.type=='text': R['textSeen'] |= bool(block.text)
        if block.type=='tool_use': args(block.input)
    if TOOL and SCENARIO=='tool':
        tc=next(b for b in r.content if b.type=='tool_use')
        kw['messages'] += [{'role':'assistant','content':[b.model_dump(exclude_none=True) for b in r.content]},{'role':'user','content':[{'type':'tool_result','tool_use_id':tc.id,'content':'sunny'}]}]
        rr=client.messages.create(**kw); R['secondTurn']=any(b.type=='text' and b.text for b in rr.content)
    client.close()
def run_genai():
    from google import genai
    from google.genai import types
    vertex=os.environ['ROW']=='vertex'
    client=genai.Client(vertexai=vertex,**({'project':'rovara-test-project','location':'us-central1'} if vertex else {'api_key':KEY}),http_options=types.HttpOptions(base_url=BASE,timeout=20000))
    if SCENARIO=='embeddings':
        r=client.models.embed_content(model='gemini-embedding-001',contents='compat-text',config={'output_dimensionality':8}); vector(r.embeddings[0].values); return
    kw=dict(model='gemini-test',contents=PROMPT)
    if TOOL: kw['config']={'tools':[{'function_declarations':[{'name':'weather','parameters':SCHEMA}]}], 'automatic_function_calling':{'disable':True}}
    def consume(r):
        R['textSeen'] |= bool(r.text)
        R['usageSeen'] |= r.usage_metadata is not None and r.usage_metadata.total_token_count is not None
        for c in r.candidates or []: finish(c.finish_reason)
        if r.prompt_feedback and r.prompt_feedback.block_reason: finish(r.prompt_feedback.block_reason)
        for fc in r.function_calls or []: args(fc.args)
    if STREAM:
        for r in client.models.generate_content_stream(**kw): consume(r)
    else:
        r=client.models.generate_content(**kw); consume(r)
        if TOOL and SCENARIO=='tool':
            kw['contents']=[types.Content(role='user',parts=[types.Part(text=PROMPT)]),r.candidates[0].content,types.Content(role='user',parts=[types.Part.from_function_response(name='weather',response={'weather':'sunny'})])]
            rr=client.models.generate_content(**kw); R['secondTurn']=bool(rr.text)
    client.close()
def run_legacy():
    import google.generativeai as genai
    genai.configure(api_key=KEY,transport='rest',client_options={'api_endpoint':BASE})
    if SCENARIO=='embeddings':
        r=genai.embed_content(model='models/embedding-test',content='compat-text',output_dimensionality=8); vector(r['embedding']); return
    legacy_schema={'type':'OBJECT','properties':{'city':{'type':'STRING'}},'required':['city']}
    model=genai.GenerativeModel('gemini-test',tools=[{'function_declarations':[{'name':'weather','description':'weather lookup','parameters':legacy_schema}]}] if TOOL else None)
    r=model.generate_content(PROMPT,stream=STREAM)
    if STREAM:
        for chunk in r:
            for c in chunk.candidates:
                for p in c.content.parts: R['textSeen'] |= bool(p.text)
        r.resolve()
    for c in r.candidates:
        finish(c.finish_reason.name)
        for p in c.content.parts:
            R['textSeen'] |= bool(p.text)
            if p.function_call.name: args(dict(p.function_call.args))
    if r.prompt_feedback.block_reason: finish(r.prompt_feedback.block_reason.name)
    R['usageSeen']=r.usage_metadata.total_token_count>=0
    if TOOL and SCENARIO=='tool':
        rr=model.generate_content([{'role':'user','parts':[PROMPT]},r.candidates[0].content,{'role':'user','parts':[{'function_response':{'name':'weather','response':{'weather':'sunny'}}}]}]); R['secondTurn']=bool(rr.text)
def run_cohere():
    import cohere
    client=cohere.ClientV2(api_key=KEY,base_url=BASE,timeout=20)
    if SCENARIO=='embeddings':
        r=client.embed(model='embed-test',texts=['compat-text'],input_type='search_document',embedding_types=['float']); vector(r.embeddings.float_[0]); return
    kw=dict(model='command-test',messages=[{'role':'user','content':PROMPT}])
    if TOOL: kw['tools']=[{'type':'function','function':{'name':'weather','parameters':SCHEMA}}]
    if STREAM:
        raw=''
        for event in client.chat_stream(**kw):
            kind=event.type
            if kind=='content-delta': R['textSeen'] |= bool(event.delta.message.content.text)
            elif kind=='tool-call-start': raw += event.delta.message.tool_calls.function.arguments or ''
            elif kind=='tool-call-delta': raw += event.delta.message.tool_calls.function.arguments or ''
            elif kind=='message-end': finish(event.delta.finish_reason); R['usageSeen']=event.delta.usage is not None
        if TOOL: args(raw)
    else:
        r=client.chat(**kw); finish(r.finish_reason); R['textSeen']=any(getattr(c,'text','') for c in r.message.content or []); R['usageSeen']=r.usage is not None
        if TOOL:
            tc=r.message.tool_calls[0]; args(tc.function.arguments)
            if SCENARIO=='tool':
                kw['messages'] += [r.message.model_dump(exclude_none=True),{'role':'tool','tool_call_id':tc.id,'content':'sunny'}]
                rr=client.chat(**kw); R['secondTurn']=any(getattr(c,'text','') for c in rr.message.content or [])
def run_langchain():
    from langchain_core.messages import HumanMessage, ToolMessage
    if LIB=='langchain-openai':
        from langchain_openai import ChatOpenAI, OpenAIEmbeddings
        if SCENARIO=='embeddings':
            # Avoid local tokenization's network-fetched tokenizer data.
            vector(OpenAIEmbeddings(model='embed-test',api_key=KEY,base_url=BASE,dimensions=8,check_embedding_ctx_length=False).embed_query('compat-text')); return
        model=ChatOpenAI(model='gpt-test',api_key=KEY,base_url=BASE,timeout=20)
    else:
        from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings
        if SCENARIO=='embeddings':
            vector(GoogleGenerativeAIEmbeddings(model='models/embedding-test',google_api_key=KEY,base_url=BASE,output_dimensionality=8).embed_query('compat-text')); return
        kw=dict(model='gemini-test',base_url=BASE,timeout=20)
        if os.environ['ROW']=='vertex': kw.update(vertexai=True,project='rovara-test-project',location='us-central1')
        else: kw['api_key']=KEY
        model=ChatGoogleGenerativeAI(**kw)
    if TOOL: model=model.bind_tools([{'name':'weather','description':'weather lookup','parameters':SCHEMA}])
    messages=[HumanMessage(content=PROMPT)]
    if STREAM:
        r=None
        for chunk in model.stream(messages):
            R['textSeen'] |= bool(chunk.content)
            r=chunk if r is None else r+chunk
    else: r=model.invoke(messages)
    R['textSeen'] |= bool(r.content); R['usageSeen']=r.usage_metadata is not None
    finish(r.response_metadata.get('finish_reason') or r.response_metadata.get('stop_reason') or r.response_metadata.get('prompt_feedback',{}).get('block_reason'))
    if TOOL:
        if r.invalid_tool_calls: args(r.invalid_tool_calls[0]['args'])
        elif r.tool_calls: args(r.tool_calls[0]['args'])
        if SCENARIO=='tool':
            rr=model.invoke(messages+[r,ToolMessage(content='sunny',tool_call_id=r.tool_calls[0]['id'])]); R['secondTurn']=bool(rr.content)
try:
    stage='call'
    {'openai':run_openai,'anthropic':run_anthropic,'google-genai':run_genai,'google-generativeai':run_legacy,'cohere':run_cohere,'langchain-openai':run_langchain,'langchain-google-genai':run_langchain}[LIB]()
except Exception as error:
    cls=type(error).__name__
    R['outcome']='error'; R['errorClass']=cls if re.fullmatch(r'[A-Za-z0-9_]{1,100}',cls) else 'UnknownError'
    status=getattr(error,'status_code',None) or getattr(error,'code',None) or getattr(error,'status',None)
    cause=error.__cause__
    if status is None and cause is not None: status=getattr(cause,'status_code',None) or getattr(cause,'code',None)
    if callable(status): status=status()
    if isinstance(status,int) and 100<=status<=599: R['status']=status
    R['messageSeen']=bool(str(error))
    mro={c.__name__ for c in type(error).__mro__}
    if cls in {'BlockedPromptException','LengthFinishReasonError','ContentFilterFinishReasonError'}: R['raisedIn']='customer'
    elif mro & {'APIError','APIStatusError','GoogleAPICallError','ApiError','ClientError','ServerError','ModelError','GoogleGenerativeAIError'}: R['raisedIn']='api'
    elif cls in {'ReadError','RemoteProtocolError','IncompleteRead','APIConnectionError','ChunkedEncodingError'}: R['raisedIn']='transport'
    else: R['raisedIn']='parser'
print(json.dumps(R,separators=(',',':')))
