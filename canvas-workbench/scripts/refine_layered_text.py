"""Source-pixel typography and bounded local clean-plate repair; no model calls."""
import argparse,json,math,sys,re,unicodedata
from pathlib import Path
from statistics import median
from PIL import Image,ImageDraw,ImageFilter,ImageOps,ImageChops
from infer_text_style import infer_block,pixel_foreground,fit_font,has_cjk,font_candidates
from layered_image import strict_font

def bounds(element,size,padding=0):
    b=element.get('cleanupBounds') or element
    vals=[b.get(k) for k in ('x','y','width','height')]
    if any(not isinstance(v,(int,float)) or isinstance(v,bool) or not math.isfinite(v) for v in vals): raise ValueError('文字坐标无效')
    x,y,w,h=vals
    if w<=0 or h<=0:raise ValueError('文字尺寸无效')
    return (max(0,math.floor(x-padding)),max(0,math.floor(y-padding)),min(size[0],math.ceil(x+w+padding)),min(size[1],math.ceil(y+h+padding)))

def ocr_token_regions(im,lines):
    """Measure separated menu labels/prices from source ink, not character ratios.
    OCR owns geometry only: callers require an exact text match before using it.
    """
    regions=[]
    for line in lines:
        if line.get('confidence',0)<85:continue
        tokens=str(line.get('text','')).split()
        if not tokens:continue
        try:box=bounds(line,im.size,2)
        except (ValueError,TypeError):continue
        fg=pixel_foreground(im,box,None,ignore_leaders=True)
        if not fg:continue
        mask=fg['mask'];occupied=[x for x in range(mask.width) if mask.crop((x,0,x+1,mask.height)).getbbox()]
        gaps=sorted([(b-a-1,a,b) for a,b in zip(occupied,occupied[1:]) if b>a+1],reverse=True)
        if len(tokens)>1 and (len(gaps)<len(tokens)-1 or gaps[len(tokens)-2][0]<mask.height*.4):continue
        cuts=sorted((a+b)//2 for _,a,b in gaps[:len(tokens)-1]);edges=[0,*cuts,mask.width]
        measured=[]
        for text,left,right in zip(tokens,edges,edges[1:]):
            ink=mask.crop((left,0,right,mask.height)).getbbox()
            if not ink:continue
            a,b,c,d=ink
            measured.append({'text':text,'x':fg['left']+(left+a)/fg['sx'],'y':fg['top']+b/fg['sy'],
                'width':(c-a)/fg['sx'],'height':(d-b)/fg['sy']})
        # OCR engines sometimes return a row in price-first reading order.
        # Do not assign those words to left-to-right spans by assumption.
        if any(r['height']<line['height']*.35 or (len(r['text'])>=2 and not .25<r['width']/max(1,len(r['text'])*r['height'])<1.5) for r in measured):continue
        regions.extend(measured)
    return regions

def match_token(e,regions):
    compact=lambda s:re.sub(r'[^a-z0-9\u3400-\u9fff]','',unicodedata.normalize('NFKC',str(s)).lower())
    text=compact(e.get('text',''))
    matches=[r for r in regions if text and compact(r['text'])==text and abs(r['y']-e['y'])<=max(r['height'],e['height'])*.8
        and min(r['x']+r['width'],e['x']+e['width'])-max(r['x'],e['x'])>=min(r['width'],e['width'])*.35]
    return min(matches,key=lambda r:abs(r['y']-e['y'])*4+abs(r['x']-e['x'])) if matches else None

def refine(spec):
    im=ImageOps.exif_transpose(Image.open(spec['input'])).convert('RGB')
    if im.width*im.height>20_000_000:raise ValueError('图片超过2000万像素')
    result=[];issues=[];warnings=[];tokens=ocr_token_regions(im,spec.get('ocrLines',[]))
    for raw in spec['elements']:
        e=dict(raw)
        if e.get('type')!='text' or not e.get('enabled',True): result.append(e);continue
        # A new calibration must measure the new OCR geometry, never an old
        # narrow cleanup box left over from the previous fit.
        e.pop('cleanupBounds',None);e.pop('textFit',None)
        token=match_token(e,tokens)
        ambiguous=e.get('geometrySource')=='source-ocr-token' and token is None
        if token:
            e.update({k:round(token[k]) for k in ('x','y','width','height')});e['geometrySource']='source-ocr-token'
        x1,y1,x2,y2=bounds(e,im.size)
        e['cleanupBounds']={'x':x1,'y':y1,'width':x2-x1,'height':y2-y1}
        if not str(e.get('text','')).strip():
            issues.append({'id':e['id'],'code':'empty-text','severity':'error','message':'文字为空，请核对识别结果'});result.append(e);continue
        if ('\n' in e['text'] or '\r' in e['text'] or abs(float(e.get('rotation',0)))>2) and not spec.get('complete'):
            e['fontAccepted']=False
            issues.append({'id':e['id'],'code':'unsupported-text-geometry','severity':'review','message':'此文字含复杂行式或旋转，自动保留原字形区域'});result.append(e);continue
        e['sourceSearchPadding']=min(12,max(4,(y2-y1)*.15))
        multiline='\n' in e['text'] or '\r' in e['text']
        fitted=dict(e) if multiline else infer_block(im,e)
        # A low score may still supply useful placement for an explicit
        # replacement-font policy; it is never labelled an original-font match.
        if not fitted.get('textFit'):
            pad=math.ceil(e['sourceSearchPadding'])
            fg=pixel_foreground(im,(max(0,x1-pad),max(0,y1-pad),min(im.width,x2+pad),min(im.height,y2+pad)),e.get('color'),ignore_leaders=not e['text'].endswith(('.', '。', '…', '·')))
            best=fit_font(e['text'],fg,has_cjk(e['text'])) if fg and not multiline else None
            if best and best['widthError']<=.2 and best['heightError']<=.2:
                for key in ('fontFamily','fontPostScript','fontWeight','fontSize','tracking'):fitted[key]=best[key]
                fitted['color']=fg['color'];fitted['fontCandidates']=best['candidates'];fitted['styleConfidence']=round(max(0,best['score']),3)
                fitted['textFit']={'text':e['text'],'fontPostScript':best['fontPostScript'],'fontSize':best['fontSize'],'tracking':best['tracking'],
                    'baselineOffset':fg['top']-e['y']+best['baseline'],'originOffsetX':fg['left']-e['x']-best['bearing'],'advance':best['advance']}
                fitted['styleNote']='按原图校准位置，字体为近似替换，未恢复原字体'
        pad=math.ceil(e['sourceSearchPadding'])
        ink=pixel_foreground(im,(max(0,x1-pad),max(0,y1-pad),min(im.width,x2+pad),min(im.height,y2+pad)),e.get('color'),ignore_leaders=not e['text'].endswith(('.', '。', '…', '·')))
        fitted['cleanupBounds']=({'x':max(0,math.floor(ink['left'])),'y':max(0,math.floor(ink['top'])),
            'width':math.ceil(ink['mask'].width/ink['sx']),'height':math.ceil(ink['mask'].height/ink['sy'])} if ink else e['cleanupBounds'])
        if token and ink and not fitted.get('textFit'):
            # Content is independently confirmed; inability to find the exact
            # old font must not flatten ordinary menu copy. Fit an installed
            # substitute *inside* the measured source ink box without overflow.
            choices=font_candidates(has_cjk(e['text']))
            if choices:
                family,ps,weight,_=choices[0]
                try:
                    probe=strict_font(ps,48,e['text']);bb=probe.getbbox(e['text'],anchor='ls');tw=ink['mask'].width/ink['sx'];th=ink['mask'].height/ink['sy']
                    size=max(8,math.floor(48*min(tw/max(1,bb[2]-bb[0]),th/max(1,bb[3]-bb[1]))));font=strict_font(ps,size,e['text']);bb=font.getbbox(e['text'],anchor='ls')
                    if bb[2]-bb[0]<=tw+1 and bb[3]-bb[1]<=th+1:
                        fitted.update(fontFamily=family,fontPostScript=ps,fontWeight=weight,fontSize=size,tracking=0,color=ink['color'])
                        fitted['textFit']={'text':e['text'],'fontPostScript':ps,'fontSize':size,'tracking':0,'originOffsetX':ink['left']-e['x']-bb[0],
                            'baselineOffset':ink['top']-e['y']-bb[1]+max(0,(th-(bb[3]-bb[1]))/2),'advance':font.getlength(e['text'])}
                        fitted['styleNote']='原文已由模型和OCR对应确认，使用可编辑替代字体并限制在原字区域内；不是原字体匹配'
                        issues.append({'id':e['id'],'code':'font-layout-substitution','severity':'warning','message':fitted['styleNote']})
                except (ValueError,OSError):pass
        fitted.pop('sourceSearchPadding',None)
        fitted['fontAccepted']=False
        border=list(im.crop((x1,max(0,y1-2),x2,max(1,y1))).getdata())
        bg=tuple(median(p[k] for p in border) for k in range(3)) if border else (255,255,255)
        color=fitted.get('color','#111111');rgb=tuple(int(color[k:k+2],16) for k in (1,3,5))
        if ambiguous or max(abs(rgb[k]-bg[k]) for k in range(3))<40:
            fitted.pop('textFit',None)
        if spec.get('complete') and not fitted.get('textFit'):
            # An explicit reconstruction may replace the font; a low original
            # font-match score is not a reason to bake readable copy into PNG.
            choices=font_candidates(has_cjk(e['text']))
            for family,ps,weight,_ in choices:
                try:
                    target=e if multiline else fitted.get('cleanupBounds') or e
                    tw,th=target['width'],target['height'];probe=strict_font(ps,48,e['text']);lines=e['text'].replace('\r','\n').split('\n')
                    boxes=[probe.getbbox(line or ' ',anchor='ls') for line in lines]
                    bb=(min(b[0] for b in boxes),min(b[1] for b in boxes),max(b[2] for b in boxes),max(b[3] for b in boxes))
                    size=max(8,math.floor(48*min(tw/max(1,bb[2]-bb[0]),th/max(1,bb[3]-bb[1]+48*1.2*(len(lines)-1)))))
                    font=strict_font(ps,size,e['text']);boxes=[font.getbbox(line or ' ',anchor='ls') for line in lines]
                    bb=(min(b[0] for b in boxes),min(b[1] for b in boxes),max(b[2] for b in boxes),max(b[3] for b in boxes))
                    if bb[2]-bb[0]>tw+2 or bb[3]-bb[1]+size*1.2*(len(lines)-1)>th+2:continue
                    leading=(th-(bb[3]-bb[1]))/(len(lines)-1) if multiline and len(lines)>1 else size*1.2
                    fitted.update(fontFamily=family,fontPostScript=ps,fontWeight=weight,fontSize=size,tracking=0)
                    fitted['textFit']={'text':e['text'],'fontPostScript':ps,'fontSize':size,'tracking':0,
                        'originOffsetX':target['x']-e['x']-bb[0],'baselineOffset':target['y']-e['y']-bb[1]+(0 if multiline else max(0,(th-(bb[3]-bb[1]))/2)),
                        'advance':max(font.getlength(line) for line in lines),'leading':leading}
                    fitted['styleNote']='完整重建使用可编辑替代字体；内容与位置仍须对照原图核验'
                    issues.append({'id':e['id'],'code':'font-layout-substitution','severity':'warning','message':fitted['styleNote']});break
                except (ValueError,OSError):continue
        try:
            strict_font(fitted['fontPostScript'],float(fitted['fontSize']),fitted['text'])
            fitted['fontAvailable']=True
        except Exception as ex:
            fitted['fontAvailable']=False
            issues.append({'id':e['id'],'code':'font-unavailable','severity':'error','message':str(ex)[:300]})
        if not fitted.get('textFit'):
            issues.append({'id':e['id'],'code':'font-fit-unresolved','severity':'review','message':'未能可靠校准字形与位置，自动保留原字形区域'})
        elif float(fitted.get('styleConfidence',0))<.55 and not token and not spec.get('complete'):
            issues.append({'id':e['id'],'code':'font-fit-unresolved','severity':'review','message':'字形匹配分偏低，自动保留原字形区域','score':fitted.get('styleConfidence',0)})
        elif float(fitted.get('styleConfidence',0))<.9:
            issues.append({'id':e['id'],'code':'substitute-font','severity':'warning','message':'使用已安装的近似字体；不代表找回原字体','score':fitted.get('styleConfidence',0)})
        # The caller chooses strict/substitute policy, never the pixel helper.
        result.append(fitted)
    return {'success':True,'elements':result,'issues':issues,'warnings':warnings}

def clean_background(spec):
    im=Image.open(spec['input']).convert('RGBA');source=Image.open(spec['source']).convert('RGBA')
    if im.size!=source.size:raise ValueError('背景与原图尺寸不同')
    if im.width*im.height>20_000_000:raise ValueError('背景超过2000万像素')
    result=im.copy();issues=[];repairs=[]
    for e in spec['elements']:
        if not e.get('enabled',True) or not e.get('nativeText'):continue
        x1,y1,x2,y2=bounds(e,im.size,4)
        if e.get('bounds'):
            a,b,c,d=bounds({'cleanupBounds':e['bounds']},im.size,4)
            x1,y1,x2,y2=min(x1,a),min(y1,b),max(x2,c),max(y2,d)
        if x2<=x1 or y2<=y1:continue
        expected_ink=None
        if e.get('file'):
            try:
                with Image.open(e['file']) as rendered:
                    if rendered.size==im.size:
                        expected_ink=rendered.convert('RGBA').getchannel('A').crop((x1,y1,x2,y2)).filter(ImageFilter.MaxFilter(7))
            except (OSError,ValueError):pass
        if e.get('geometrySource')=='source-ocr-token':
            # A substitute font has a different silhouette. Remove the known
            # original ink as well, so it cannot survive beside live glyphs.
            fg=pixel_foreground(source,(x1,y1,x2,y2),e.get('color'),ignore_leaders=True)
            if fg:
                ink=Image.new('L',(x2-x1,y2-y1));tile=fg['mask'].resize((max(1,round(fg['mask'].width/fg['sx'])),max(1,round(fg['mask'].height/fg['sy']))))
                ink.paste(tile,(round(fg['left']-x1),round(fg['top']-y1)));ink=ink.filter(ImageFilter.MaxFilter(3))
                expected_ink=ImageChops.lighter(expected_ink,ink) if expected_ink is not None else ink
        if (x2-x1)*(y2-y1)>2_000_000:
            issues.append({'id':e['id'],'code':'background-region-large','severity':'review','message':'文字清理区域过大，已停止自动局部填补'});continue
        pix=result.load();top=max(0,y1-3);bottom=min(im.height-1,y2+2)
        # A non-flat surface is not proof that the original text survived.
        # Check its known source ink before attempting any flat-colour repair;
        # this leaves clean gradients/light rays untouched instead of blocking.
        color=str(e.get('color',''))
        if len(color)==7 and color[0]=='#':
            try: ink=tuple(int(color[k:k+2],16) for k in (1,3,5))
            except ValueError: ink=None
            if ink:
                close=lambda p:max(abs(p[k]-ink[k]) for k in range(3))<=35
                old=list(source.crop((x1,y1,x2,y2)).getdata());now=list(result.crop((x1,y1,x2,y2)).getdata())
                old_ink=sum(close(p) for p in old);remaining=sum(close(p) for p in now)
                if old_ink>=20 and remaining<=max(2,old_ink*.002):continue
        # Border colour must describe the same simple surface. A robust
        # percentile tolerates a few external leader dots without erasing them.
        border=[pix[x,top][:3] for x in range(x1,x2)]+[pix[x,bottom][:3] for x in range(x1,x2)]
        center=tuple(median(p[k] for p in border) for k in range(3))
        deviations=sorted(max(abs(p[k]-center[k]) for k in range(3)) for p in border)
        if deviations[int((len(deviations)-1)*.85)]>20:
            issues.append({'id':e['id'],'code':'textured-background','severity':'review','message':'文字后方为复杂纹理，未用纯色填补，请复核独立背景'});continue
        expected={}
        for x in range(x1,x2):
            a=tuple(round(median(pix[x,max(0,top-d)][k] for d in range(3))) for k in range(4))
            b=tuple(round(median(pix[x,min(im.height-1,bottom+d)][k] for d in range(3))) for k in range(4))
            expected[x]=(a,b)
        samples=[]
        stride=max(1,int(math.sqrt((x2-x1)*(y2-y1)/4000)))
        for y in range(y1,y2,stride):
            ratio=(y-top)/max(1,bottom-top)
            for x in range(x1,x2,stride):
                # Dense glyph strokes are the foreground to erase, not proof
                # of a textured background. Exclude only the fitted native
                # glyph footprint, never arbitrary dark pixels in a photo.
                if expected_ink is not None and expected_ink.getpixel((x-x1,y-y1))>0:continue
                a,b=expected[x];p=pix[x,y];samples.append(max(abs(p[k]-(a[k]*(1-ratio)+b[k]*ratio)) for k in range(3)))
        if samples and sum(d<=12 for d in samples)/len(samples)<.8:
            issues.append({'id':e['id'],'code':'textured-background','severity':'review','message':'区域像素不符合简单底色，已保留纹理并等待核对'});continue
        mask=Image.new('L',(x2-x1,y2-y1));mp=mask.load();changed=0
        for y in range(y1,y2):
            ratio=(y-top)/max(1,bottom-top)
            for x in range(x1,x2):
                a,b=expected[x];p=pix[x,y]
                if (expected_ink is None or expected_ink.getpixel((x-x1,y-y1))>0) and max(abs(p[k]-(a[k]*(1-ratio)+b[k]*ratio)) for k in range(3))>12:mp[x-x1,y-y1]=255;changed+=1
        if not changed:continue
        mask=mask.filter(ImageFilter.MaxFilter(3));mp=mask.load()
        for y in range(y1,y2):
            ratio=(y-top)/max(1,bottom-top)
            for x in range(x1,x2):
                if mp[x-x1,y-y1]:
                    a,b=expected[x];p=pix[x,y];pix[x,y]=tuple(round(a[k]*(1-ratio)+b[k]*ratio) for k in range(3))+(p[3],)
        repairs.append({'id':e['id'],'bounds':{'x':x1,'y':y1,'width':x2-x1,'height':y2-y1},'pixels':changed,'reason':'simple-background-high-contrast-contamination'})
    Path(spec['output']).parent.mkdir(parents=True,exist_ok=True);result.save(spec['output'],'PNG')
    return {'success':True,'issues':issues,'warnings':[],'repairedRegions':repairs}

def run(s):
    if not isinstance(s.get('elements'),list) or len(s['elements'])>320:raise ValueError('元素清单无效或超过320层')
    if s['operation']=='refine':return refine(s)
    if s['operation']=='clean-background':return clean_background(s)
    raise ValueError('未知校准操作')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--spec',required=True);args=parser.parse_args();s={}
    try:s=json.loads(Path(args.spec).read_text(encoding='utf-8'));v=run(s);code=0
    except Exception as ex:v={'success':False,'error':str(ex)[:1000]};code=1
    encoded=json.dumps(v,ensure_ascii=False)
    if s.get('result_output'):Path(s['result_output']).write_text(encoded,encoding='utf-8')
    try:print(encoded)
    except UnicodeEncodeError:print(json.dumps(v,ensure_ascii=True))
    sys.exit(code)
