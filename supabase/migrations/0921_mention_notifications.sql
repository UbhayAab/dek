-- Private durable broadcast history; never serialized by message_json.
alter table dek.messages add column broadcast_notified boolean not null default false;
alter table dek.notification_intents add column exclude_user_ids uuid[] not null default '{}';
create index notification_intents_message_target_idx on dek.notification_intents(message_id,target_user_id)
  where kind='message' and target_user_id is not null;

create or replace function dek.mention_trim(p text,side text default 'both') returns text
language sql immutable set search_path='' as $$
select case side when 'left' then ltrim(p,w) when 'right' then rtrim(p,w) else btrim(p,w) end
from (select chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
 chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||
 chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279) w) ws
$$;

create or replace function dek.mention_limit(s text,p int,units int) returns int
language plpgsql immutable set search_path='' as $$
declare i int:=p; used int:=0; width int;
begin while i<=length(s) loop width:=case when ascii(substr(s,i,1))>65535 then 2 else 1 end;
exit when used+width>units;used:=used+width;i:=i+1;end loop;return i;end $$;
-- Bounded notification-token scanner matching the rendered block/inline subset.
-- Complete link labels and destinations are literal for tags in both renderers.
create or replace function dek.mention_indent(p text) returns int
language plpgsql immutable set search_path='' as $$
declare i int:=1; n int:=0; c text;
begin while i<=length(p) loop c:=substr(p,i,1); if c=' ' then n:=n+1;
elsif c=chr(9) then n:=n+4-n%4; else exit; end if; i:=i+1; end loop; return n; end $$;

create or replace function dek.mention_strip(p text,cols int) returns text
language plpgsql immutable set search_path='' as $$
declare i int:=1; n int:=0; w int; c text;
begin while i<=length(p) and n<cols loop c:=substr(p,i,1);
if c=' ' then n:=n+1; elsif c=chr(9) then w:=4-n%4;
if n+w>cols then return repeat(' ',n+w-cols)||substr(p,i+1); end if; n:=n+w;
else exit; end if; i:=i+1; end loop; return substr(p,i); end $$;

create or replace function dek.mention_marker(p text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare n int:=dek.mention_indent(p); s text:=ltrim(p,E' \t'); m text[]; k int; spaces int; txt text;
begin m:=regexp_match(s,'^([-*+]|[0-9]{1,9}[.)])([ \t]+)(.*)$');
if m is null then return null; end if; txt:=dek.mention_trim(m[3],'right'); if txt='' then return null; end if;
k:=length(m[1]); spaces:=length(m[2]);
return jsonb_build_object('indent',n,'ordered',k>1,'ch',right(m[1],1),'start',case when k>1 then left(m[1],k-1)::int else 1 end,
 'col',n+k+case when spaces>4 then 1 else spaces end,'text',txt); end $$;

create or replace function dek.mention_fence(p text) returns int
language plpgsql immutable set search_path='' as $$
declare s text:=dek.mention_trim(p,'left'); m text;
begin if dek.mention_indent(p)>3 then return 0; end if;
m:=substring(s from ('^'||chr(96)||'{3,}')); if m is null or strpos(substr(s,length(m)+1),chr(96))>0 then return 0; end if;
return length(m); end $$;

create or replace function dek.mention_quote(p text) returns text
language plpgsql immutable set search_path='' as $$
declare s text:=dek.mention_trim(p,'left');
begin if dek.mention_indent(p)>3 or left(s,1)<>'>' then return null; end if; s:=substr(s,2);
if left(s,1) in (' ',chr(9)) then s:=substr(s,2); end if; return s; end $$;

-- Return the end of a syntactically complete link (1-based position after ')').
create or replace function dek.mention_link_end(s text,p int) returns int
language plpgsql immutable set search_path='' as $$
declare n int:=length(s); i int:=p; j int; lim int; parens int:=0; c text; d text; closer text;
punct constant text:='!"#$%&''()*+,-./:;<=>?@[\]^_`{|}~';
begin
while substr(s,i,1) in (' ',chr(9)) loop i:=i+1; end loop;
if substr(s,i,1)='<' then
  j:=i+1;lim:=dek.mention_limit(s,j,2048);
  while j<lim and substr(s,j,1) not in ('>','<',chr(10)) loop j:=j+1; end loop;
  if substr(s,j,1)<>'>' then return 0; end if; i:=j+1;
else
  lim:=dek.mention_limit(s,i,2048);
  while i<lim loop c:=substr(s,i,1);d:=substr(s,i+1,1);
    if c=chr(92) and d<>'' and strpos(punct,d)>0 then i:=i+2;continue;end if;
    exit when c in (' ',chr(9),chr(10));
    if c='(' then parens:=parens+1;if parens>32 then return 0;end if;
    elsif c=')' then if parens=0 then exit;end if;parens:=parens-1;end if;
    i:=i+1;
  end loop;
  if i>=lim and lim<n+1 then return 0;end if;
end if;
while substr(s,i,1) in (' ',chr(9),chr(10)) loop i:=i+1;end loop;
c:=substr(s,i,1);
if c in ('"','''','(') then
  closer:=case when c='(' then ')' else c end;j:=i+1;lim:=dek.mention_limit(s,i+1,1024);
  while j<lim and substr(s,j,1)<>closer loop j:=j+1;end loop;
  if substr(s,j,1)<>closer then return 0;end if;i:=j+1;
  while substr(s,i,1) in (' ',chr(9)) loop i:=i+1;end loop;
end if;
if substr(s,i,1)<>')' then return 0;end if;return i+1;end $$;

create or replace function dek.mention_bare_end(s text,p int) returns int
language plpgsql immutable set search_path='' as $$
declare head text:=lower(substr(s,p,8));prefix int;j int:=p;lim int;ending int;c text;opener text;part text;
begin
prefix:=case when head like 'www.%' then 4 when head like 'https://%' then 8 when head like 'http://%' then 7 else 0 end;
if prefix=0 then return 0;end if;lim:=dek.mention_limit(s,p,2048);
while j<lim loop c:=substr(s,j,1);exit when c in ('<','>','"',chr(96)) or dek.mention_trim(c)='';j:=j+1;end loop;
ending:=j;
while ending>p loop c:=substr(s,ending-1,1);
  if strpos('.,:;!?''"*_~',c)>0 then ending:=ending-1;continue;end if;
  opener:=case c when ')' then '(' when ']' then '[' when '}' then '{' else '' end;
  if opener<>'' then part:=substr(s,p,ending-p);
    if length(part)-length(replace(part,c,''))>length(part)-length(replace(part,opener,'')) then ending:=ending-1;continue;end if;
  end if;exit;
end loop;
if ending-p<=prefix then return 0;end if;return ending;end $$;

-- Frozen Unicode16.0 URL-start word set; shared with url-word-ranges.json.
create or replace function dek.mention_word(c text) returns boolean
language plpgsql immutable set search_path='' as $$
declare cp int; lo int:=1; hi int:=819; mid int;
bounds constant int[]:=array[48,57,65,90,97,122,170,170,178,179,181,181,185,186,188,190,192,214,216,246,248,705,710,721,736,740,748,748,750,750,768,884,886,887,890,893,895,895,902,902,904,906,908,908,910,929,931,1013,1015,1153,1155,1327,1329,1366,1369,1369,1376,1416,1425,1469,1471,1471,1473,1474,1476,1477,1479,1479,1488,1514,1519,1522,1552,1562,1568,1641,1646,1747,1749,1756,1759,1768,1770,1788,1791,1791,1808,1866,1869,1969,1984,2037,2042,2042,2045,2045,2048,2093,2112,2139,2144,2154,2160,2183,2185,2190,2199,2273,2275,2403,2406,2415,2417,2435,2437,2444,2447,2448,2451,2472,2474,2480,2482,2482,2486,2489,2492,2500,2503,2504,2507,2510,2519,2519,2524,2525,2527,2531,2534,2545,2548,2553,2556,2556,2558,2558,2561,2563,2565,2570,2575,2576,2579,2600,2602,2608,2610,2611,2613,2614,2616,2617,2620,2620,2622,2626,2631,2632,2635,2637,2641,2641,2649,2652,2654,2654,2662,2677,2689,2691,2693,2701,2703,2705,2707,2728,2730,2736,2738,2739,2741,2745,2748,2757,2759,2761,2763,2765,2768,2768,2784,2787,2790,2799,2809,2815,2817,2819,2821,2828,2831,2832,2835,2856,2858,2864,2866,2867,2869,2873,2876,2884,2887,2888,2891,2893,2901,2903,2908,2909,2911,2915,2918,2927,2929,2935,2946,2947,2949,2954,2958,2960,2962,2965,2969,2970,2972,2972,2974,2975,2979,2980,2984,2986,2990,3001,3006,3010,3014,3016,3018,3021,3024,3024,3031,3031,3046,3058,3072,3084,3086,3088,3090,3112,3114,3129,3132,3140,3142,3144,3146,3149,3157,3158,3160,3162,3165,3165,3168,3171,3174,3183,3192,3198,3200,3203,3205,3212,3214,3216,3218,3240,3242,3251,3253,3257,3260,3268,3270,3272,3274,3277,3285,3286,3293,3294,3296,3299,3302,3311,3313,3315,3328,3340,3342,3344,3346,3396,3398,3400,3402,3406,3412,3427,3430,3448,3450,3455,3457,3459,3461,3478,3482,3505,3507,3515,3517,3517,3520,3526,3530,3530,3535,3540,3542,3542,3544,3551,3558,3567,3570,3571,3585,3642,3648,3662,3664,3673,3713,3714,3716,3716,3718,3722,3724,3747,3749,3749,3751,3773,3776,3780,3782,3782,3784,3790,3792,3801,3804,3807,3840,3840,3864,3865,3872,3891,3893,3893,3895,3895,3897,3897,3902,3911,3913,3948,3953,3972,3974,3991,3993,4028,4038,4038,4096,4169,4176,4253,4256,4293,4295,4295,4301,4301,4304,4346,4348,4680,4682,4685,4688,4694,4696,4696,4698,4701,4704,4744,4746,4749,4752,4784,4786,4789,4792,4798,4800,4800,4802,4805,4808,4822,4824,4880,4882,4885,4888,4954,4957,4959,4969,4988,4992,5007,5024,5109,5112,5117,5121,5740,5743,5759,5761,5786,5792,5866,5870,5880,5888,5909,5919,5940,5952,5971,5984,5996,5998,6000,6002,6003,6016,6099,6103,6103,6108,6109,6112,6121,6128,6137,6155,6157,6159,6169,6176,6264,6272,6314,6320,6389,6400,6430,6432,6443,6448,6459,6470,6509,6512,6516,6528,6571,6576,6601,6608,6618,6656,6683,6688,6750,6752,6780,6783,6793,6800,6809,6823,6823,6832,6862,6912,6988,6992,7001,7019,7027,7040,7155,7168,7223,7232,7241,7245,7293,7296,7306,7312,7354,7357,7359,7376,7378,7380,7418,7424,7957,7960,7965,7968,8005,8008,8013,8016,8023,8025,8025,8027,8027,8029,8029,8031,8061,8064,8116,8118,8124,8126,8126,8130,8132,8134,8140,8144,8147,8150,8155,8160,8172,8178,8180,8182,8188,8304,8305,8308,8313,8319,8329,8336,8348,8400,8432,8450,8450,8455,8455,8458,8467,8469,8469,8473,8477,8484,8484,8486,8486,8488,8488,8490,8493,8495,8505,8508,8511,8517,8521,8526,8526,8528,8585,9312,9371,9450,9471,10102,10131,11264,11492,11499,11507,11517,11517,11520,11557,11559,11559,11565,11565,11568,11623,11631,11631,11647,11670,11680,11686,11688,11694,11696,11702,11704,11710,11712,11718,11720,11726,11728,11734,11736,11742,11744,11775,11823,11823,12293,12295,12321,12335,12337,12341,12344,12348,12353,12438,12441,12442,12445,12447,12449,12538,12540,12543,12549,12591,12593,12686,12690,12693,12704,12735,12784,12799,12832,12841,12872,12879,12881,12895,12928,12937,12977,12991,13312,19903,19968,42124,42192,42237,42240,42508,42512,42539,42560,42610,42612,42621,42623,42737,42775,42783,42786,42888,42891,42957,42960,42961,42963,42963,42965,42972,42994,43047,43052,43052,43056,43061,43072,43123,43136,43205,43216,43225,43232,43255,43259,43259,43261,43309,43312,43347,43360,43388,43392,43456,43471,43481,43488,43518,43520,43574,43584,43597,43600,43609,43616,43638,43642,43714,43739,43741,43744,43759,43762,43766,43777,43782,43785,43790,43793,43798,43808,43814,43816,43822,43824,43866,43868,43881,43888,44010,44012,44013,44016,44025,44032,55203,55216,55238,55243,55291,63744,64109,64112,64217,64256,64262,64275,64279,64285,64296,64298,64310,64312,64316,64318,64318,64320,64321,64323,64324,64326,64433,64467,64829,64848,64911,64914,64967,65008,65019,65024,65039,65056,65071,65136,65140,65142,65276,65296,65305,65313,65338,65345,65370,65382,65470,65474,65479,65482,65487,65490,65495,65498,65500,65536,65547,65549,65574,65576,65594,65596,65597,65599,65613,65616,65629,65664,65786,65799,65843,65856,65912,65930,65931,66045,66045,66176,66204,66208,66256,66272,66299,66304,66339,66349,66378,66384,66426,66432,66461,66464,66499,66504,66511,66513,66517,66560,66717,66720,66729,66736,66771,66776,66811,66816,66855,66864,66915,66928,66938,66940,66954,66956,66962,66964,66965,66967,66977,66979,66993,66995,67001,67003,67004,67008,67059,67072,67382,67392,67413,67424,67431,67456,67461,67463,67504,67506,67514,67584,67589,67592,67592,67594,67637,67639,67640,67644,67644,67647,67669,67672,67702,67705,67742,67751,67759,67808,67826,67828,67829,67835,67867,67872,67897,67968,68023,68028,68047,68050,68099,68101,68102,68108,68115,68117,68119,68121,68149,68152,68154,68159,68168,68192,68222,68224,68255,68288,68295,68297,68326,68331,68335,68352,68405,68416,68437,68440,68466,68472,68497,68521,68527,68608,68680,68736,68786,68800,68850,68858,68903,68912,68921,68928,68965,68969,68973,68975,68997,69216,69246,69248,69289,69291,69292,69296,69297,69314,69316,69372,69415,69424,69460,69488,69509,69552,69579,69600,69622,69632,69702,69714,69749,69759,69818,69826,69826,69840,69864,69872,69881,69888,69940,69942,69951,69956,69959,69968,70003,70006,70006,70016,70084,70089,70092,70094,70106,70108,70108,70113,70132,70144,70161,70163,70199,70206,70209,70272,70278,70280,70280,70282,70285,70287,70301,70303,70312,70320,70378,70384,70393,70400,70403,70405,70412,70415,70416,70419,70440,70442,70448,70450,70451,70453,70457,70459,70468,70471,70472,70475,70477,70480,70480,70487,70487,70493,70499,70502,70508,70512,70516,70528,70537,70539,70539,70542,70542,70544,70581,70583,70592,70594,70594,70597,70597,70599,70602,70604,70611,70625,70626,70656,70730,70736,70745,70750,70753,70784,70853,70855,70855,70864,70873,71040,71093,71096,71104,71128,71133,71168,71232,71236,71236,71248,71257,71296,71352,71360,71369,71376,71395,71424,71450,71453,71467,71472,71483,71488,71494,71680,71738,71840,71922,71935,71942,71945,71945,71948,71955,71957,71958,71960,71989,71991,71992,71995,72003,72016,72025,72096,72103,72106,72151,72154,72161,72163,72164,72192,72254,72263,72263,72272,72345,72349,72349,72368,72440,72640,72672,72688,72697,72704,72712,72714,72758,72760,72768,72784,72812,72818,72847,72850,72871,72873,72886,72960,72966,72968,72969,72971,73014,73018,73018,73020,73021,73023,73031,73040,73049,73056,73061,73063,73064,73066,73102,73104,73105,73107,73112,73120,73129,73440,73462,73472,73488,73490,73530,73534,73538,73552,73562,73648,73648,73664,73684,73728,74649,74752,74862,74880,75075,77712,77808,77824,78895,78912,78933,78944,82938,82944,83526,90368,90425,92160,92728,92736,92766,92768,92777,92784,92862,92864,92873,92880,92909,92912,92916,92928,92982,92992,92995,93008,93017,93019,93025,93027,93047,93053,93071,93504,93548,93552,93561,93760,93846,93952,94026,94031,94087,94095,94111,94176,94177,94179,94180,94192,94193,94208,100343,100352,101589,101631,101640,110576,110579,110581,110587,110589,110590,110592,110882,110898,110898,110928,110930,110933,110933,110948,110951,110960,111355,113664,113770,113776,113788,113792,113800,113808,113817,113821,113822,118000,118009,118528,118573,118576,118598,119141,119145,119149,119154,119163,119170,119173,119179,119210,119213,119362,119364,119488,119507,119520,119539,119648,119672,119808,119892,119894,119964,119966,119967,119970,119970,119973,119974,119977,119980,119982,119993,119995,119995,119997,120003,120005,120069,120071,120074,120077,120084,120086,120092,120094,120121,120123,120126,120128,120132,120134,120134,120138,120144,120146,120485,120488,120512,120514,120538,120540,120570,120572,120596,120598,120628,120630,120654,120656,120686,120688,120712,120714,120744,120746,120770,120772,120779,120782,120831,121344,121398,121403,121452,121461,121461,121476,121476,121499,121503,121505,121519,122624,122654,122661,122666,122880,122886,122888,122904,122907,122913,122915,122916,122918,122922,122928,122989,123023,123023,123136,123180,123184,123197,123200,123209,123214,123214,123536,123566,123584,123641,124112,124153,124368,124410,124896,124902,124904,124907,124909,124910,124912,124926,124928,125124,125127,125142,125184,125259,125264,125273,126065,126123,126125,126127,126129,126132,126209,126253,126255,126269,126464,126467,126469,126495,126497,126498,126500,126500,126503,126503,126505,126514,126516,126519,126521,126521,126523,126523,126530,126530,126535,126535,126537,126537,126539,126539,126541,126543,126545,126546,126548,126548,126551,126551,126553,126553,126555,126555,126557,126557,126559,126559,126561,126562,126564,126564,126567,126570,126572,126578,126580,126583,126585,126588,126590,126590,126592,126601,126603,126619,126625,126627,126629,126633,126635,126651,127232,127244,130032,130041,131072,173791,173824,177977,177984,178205,178208,183969,183984,191456,191472,192093,194560,195101,196608,201546,201552,205743,917760,917999];
begin if c='' then return false;end if;cp:=ascii(c);
while lo<=hi loop mid:=(lo+hi)/2;
if cp<bounds[mid*2-1] then hi:=mid-1;elsif cp>bounds[mid*2] then lo:=mid+1;else return true;end if;
end loop;return false;end $$;

create or replace function dek.mention_inline(s text) returns text
language plpgsql immutable set search_path='' as $$
declare n int:=length(s); i int:=1; j int; k int; run int; closer int; ending int; c text; d text; token text;
stack int[]:='{}'; pairs jsonb:='{}'; out text:='';
punct constant text:='!"#$%&''()*+,-./:;<=>?@[\]^_`{|}~';
begin
-- Same bracket stack as matchBrackets, including its backslash handling.
while i<=n loop c:=substr(s,i,1);
  if c=chr(92) then i:=i+2;continue;
  elsif c='[' then stack:=array_append(stack,i);
  elsif c=']' and cardinality(stack)>0 then k:=stack[cardinality(stack)];stack:=trim_array(stack,1);pairs:=pairs||jsonb_build_object(k::text,i);end if;i:=i+1;
end loop;i:=1;
while i<=n loop c:=substr(s,i,1);d:=substr(s,i+1,1);
  if c=chr(92) and d<>'' and (strpos(punct,d)>0 or d=chr(10)) then i:=i+2;continue;end if;
  if c=chr(96) then
    run:=1;while substr(s,i+run,1)=chr(96) loop run:=run+1;end loop;j:=i+run;closer:=0;
    while j<=n loop
      k:=strpos(substr(s,j),chr(96));exit when k=0;j:=j+k-1;k:=1;
      while substr(s,j+k,1)=chr(96) loop k:=k+1;end loop;
      if k=run then closer:=j;exit;end if;j:=j+k;
    end loop;
    i:=case when closer>0 then closer+run else i+run end;continue;
  end if;
  if c='[' and pairs ? i::text then
    j:=(pairs->>i::text)::int;
    if substr(s,j+1,1)='(' then ending:=dek.mention_link_end(s,j+2);if ending>0 then i:=ending;continue;end if;end if;
  end if;
  if c='<' then
    token:=substring(substr(s,i) from '^<(@[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}|!(channel|here))>');
    if token is not null then token:='<'||token||'>';out:=out||token||' ';i:=i+length(token);continue;end if;
  end if;
  if c in ('h','H','w','W') and (i=1 or not dek.mention_word(substr(s,i-1,1))) then
    ending:=dek.mention_bare_end(s,i);if ending>0 then i:=ending;continue;end if;
  end if;i:=i+1;
end loop;return out;end $$;

create or replace function dek.mention_blocks(ls text[],depth int default 0) returns text
language plpgsql immutable set search_path='' as $$
declare n int:=cardinality(ls);i int:=1;k int;b int;ind int;base int;fence int;line text;q text;ahead text;
first jsonb;cur jsonb;m jsonb;am jsonb;nxt jsonb;txt text[];children text[];innerlines text[];out text:='';blockish boolean;
begin while i<=n loop
  line:=ls[i];if dek.mention_trim(line)='' then i:=i+1;continue;end if;
  fence:=dek.mention_fence(line);
  if fence>0 then
    i:=i+1;
    while i<=n loop
      exit when dek.mention_indent(ls[i])<=3 and dek.mention_trim(ls[i]) ~ ('^'||chr(96)||'{'||fence||',}$');i:=i+1;
    end loop;i:=i+1;continue;
  end if;
  q:=dek.mention_quote(line);
  if q is not null then
    innerlines:='{}';while i<=n loop q:=dek.mention_quote(ls[i]);exit when q is null;innerlines:=array_append(innerlines,q);i:=i+1;end loop;
    if depth+1>=8 then
      select coalesce(array_agg(dek.mention_trim(x)),'{}') into innerlines from unnest(innerlines) x where dek.mention_trim(x)<>'';
      out:=out||dek.mention_inline(array_to_string(innerlines,E'\n'));
    else out:=out||dek.mention_blocks(innerlines,depth+1);end if;continue;
  end if;
  first:=dek.mention_marker(line);
  if first is not null and (first->>'indent')::int<4 then
    cur:=first;
    while cur is not null loop
      txt:=array[cur->>'text'];children:='{}';nxt:=null;i:=i+1;
      while i<=n loop
        line:=ls[i];
        if dek.mention_trim(line)='' then
          k:=i+1;while k<=n and dek.mention_trim(ls[k])='' loop k:=k+1;end loop;
          if k>n then i:=k;exit;end if;
          ahead:=ls[k];am:=dek.mention_marker(ahead);ind:=dek.mention_indent(ahead);
          if am is not null and am->>'indent'=first->>'indent' and am->>'ordered'=first->>'ordered' and am->>'ch'=first->>'ch' then i:=k;nxt:=am;exit;end if;
          if ind>(first->>'indent')::int and (cardinality(children)>0 or am is not null or ind>=(cur->>'col')::int) then
            if cardinality(children)>0 then for b in i..k-1 loop children:=array_append(children,'');end loop;end if;i:=k;continue;
          end if;exit;
        end if;
        m:=dek.mention_marker(line);ind:=dek.mention_indent(line);blockish:=dek.mention_trim(line,'left') like '```%' or dek.mention_trim(line,'left') like '>%';
        if m is not null and m->>'indent'=first->>'indent' and m->>'ordered'=first->>'ordered' and m->>'ch'=first->>'ch' then nxt:=m;exit;end if;
        if m is not null and (m->>'indent')::int<=(first->>'indent')::int then exit;end if;
        if ind>(first->>'indent')::int and (m is not null or cardinality(children)>0 or (blockish and ind>=(cur->>'col')::int)) then children:=array_append(children,line);i:=i+1;continue;end if;
        exit when blockish;
        if cardinality(children)>0 then children:=array_append(children,line);else txt:=array_append(txt,dek.mention_trim(line));end if;i:=i+1;
      end loop;
      if cardinality(children)=0 then out:=out||dek.mention_inline(array_to_string(txt,E'\n'));
      elsif depth+1>=8 then
        select coalesce(array_agg(dek.mention_trim(x)),'{}') into innerlines from unnest(children) x where dek.mention_trim(x)<>'';
        out:=out||dek.mention_inline(array_to_string(txt||innerlines,E'\n'));
      else
        out:=out||dek.mention_inline(array_to_string(txt,E'\n'));
        select coalesce(min(dek.mention_indent(x)),0) into base from unnest(children) x where dek.mention_trim(x)<>'';
        select array_agg(dek.mention_strip(x,base)) into innerlines from unnest(children) x;
        out:=out||dek.mention_blocks(innerlines,depth+1);
      end if;cur:=nxt;
    end loop;continue;
  end if;
  txt:=array[dek.mention_trim(line)];i:=i+1;
  while i<=n and dek.mention_trim(ls[i])<>'' loop
    line:=ls[i];m:=dek.mention_marker(line);
    exit when dek.mention_fence(line)>0 or dek.mention_quote(line) is not null or
      (m is not null and (m->>'indent')::int<4 and (not (m->>'ordered')::boolean or (m->>'start')::int=1));
    txt:=array_append(txt,dek.mention_trim(line));i:=i+1;
  end loop;out:=out||dek.mention_inline(array_to_string(txt,E'\n'));
end loop;return out;end $$;

create or replace function dek.mention_source(p_body text) returns text
language sql immutable set search_path='' as $$
  select dek.mention_blocks(string_to_array(regexp_replace(coalesce(p_body,''),E'\r\n?',E'\n','g'),E'\n'),0)
$$;


-- Compatible message parsing/edit/routing signatures. Existing rate/role/mute/quiet-hour gates remain.
create or replace function dek.msg_parse_mentions(p_body text, p_channel uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(k.id order by k.first_at), '{}'::uuid[])
    from (select t.id, t.first_at
            from (select x.id, min(x.ord) as first_at
                    from (select lower(r.m[1])::uuid as id, r.ord
                            from regexp_matches(dek.mention_source(p_body),
                                   '<@([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})>', 'g')
                                 with ordinality as r(m, ord)) x
                   group by x.id) t
           where dek.can_read_channel(t.id, p_channel)
           order by t.first_at
           limit 100) k
$$;

create or replace function dek.msg_wants_all(p_body text)
returns boolean language sql immutable set search_path = '' as $$
  select dek.mention_source(p_body) ~ '<!(channel|here)>'
$$;

create or replace function api.edit_message(p_message uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid      uuid;
  v_msg      dek.messages;
  v_ch       dek.channels;
  v_org      dek.orgs;
  v_body     text;
  v_window   int;
  v_mentions uuid[];
  v_new      uuid[];
  v_all      boolean := false;
  v_new_all  boolean;
  v_intent bigint;
  v_json     jsonb;
begin
  v_uid := dek.require_uid();
  -- edits can add mentions, and mentions notify: bounded like sending
  perform dek.rate_hit(v_uid, 'edit', 30, 60);
  v_msg := dek.msg_get(v_uid, p_message);
  if v_msg.author_id is distinct from v_uid then
    perform dek.err('forbidden', 'You can only edit your own messages.');
  end if;
  if v_msg.deleted_at is not null then
    perform dek.err('conflict', 'That message was deleted.');
  end if;
  v_body := dek.msg_trim(p_body);
  if char_length(v_body) > 8000 then
    perform dek.err('invalid_input', 'A message can be at most 8000 characters.');
  end if;
  if v_body = '' and v_msg.attachment_count = 0 then
    perform dek.err('invalid_input', 'A message without files cannot be empty. Delete it instead.');
  end if;
  if v_body = v_msg.body then
    return dek.message_json(v_msg);   -- a retried edit, or nothing changed
  end if;
  v_ch := dek.assert_post(v_uid, v_msg.channel_id, v_msg.thread_root_id is not null);
  select * into v_org from dek.orgs where id = v_msg.org_id;
  v_window := (dek.org_settings(v_org) ->> 'edit_window_minutes')::int;
  if v_window is not null and v_msg.created_at < now() - make_interval(mins => v_window) then
    perform dek.err('forbidden', format('Messages can only be edited for %s minutes after sending.', v_window));
  end if;

  -- NO KEY UPDATE: a reply being inserted under this root only needs KEY SHARE
  select * into v_msg from dek.messages where id = v_msg.id for no key update;
  if v_msg.deleted_at is not null then
    perform dek.err('conflict', 'That message was deleted.');
  end if;

  v_mentions := dek.msg_parse_mentions(v_body, v_ch.id);
  if dek.msg_wants_all(v_body) then
    v_all := dek.msg_may_mention_all(v_uid, v_ch.id);
  end if;
  -- Mention rows are append-only per message: a person mentioned once keeps the
  -- mention (inbox, badge) even if a later edit drops the token, and is never
  -- notified twice for the same message, however often an edit removes and re-adds
  -- them. "New" therefore means "has no mention row for this message yet".
  v_new := array(
    select u from unnest(v_mentions) u
     where u <> v_uid
       and not exists (select 1 from dek.mentions mn where mn.message_id = v_msg.id and mn.user_id = u)
       and not exists (select 1 from dek.user_blocks b where b.blocker_id = u and b.blocked_id = v_uid));
  v_new_all := v_all and not (v_msg.mention_all or v_msg.broadcast_notified);

  -- new rows are dated like the message, so the mentions list stays in message order
  if cardinality(v_new) > 0 then
    insert into dek.mentions (message_id, user_id, channel_id, org_id, seq, created_at)
    select v_msg.id, u, v_msg.channel_id, v_msg.org_id, v_msg.seq, v_msg.created_at from unnest(v_new) u
    on conflict (message_id, user_id) do nothing;
    if v_msg.thread_root_id is not null then
      insert into dek.thread_follows (root_id, user_id, channel_id, org_id)
      select v_msg.thread_root_id, u, v_msg.channel_id, v_msg.org_id from unnest(v_new) u
      on conflict (root_id, user_id) do nothing;
    end if;
  end if;

  update dek.messages
     set body = v_body, mentions = v_mentions, mention_all = v_all,
         broadcast_notified = v_msg.broadcast_notified or v_msg.mention_all or v_all, edited_at = now(), updated_at = now()
   where id = v_msg.id
  returning * into v_msg;

  -- Only new mentions notify: one intent aimed at each newly mentioned person (the
  -- dispatcher sends a targeted intent to that person alone, read or not), for the
  -- first 20 of them, and one untargeted intent when <!channel> / <!here> was newly
  -- added. Each intent's dispatch trigger is a subtransaction, so 21 keeps a single
  -- edit well under the 64 a transaction caches; later ones still get the mention.
  if v_new_all then
    v_intent := dek.enqueue_intent('message', v_msg.org_id, v_msg.id, v_msg.channel_id, null, v_uid);
    update dek.notification_intents set exclude_user_ids=coalesce(v_new[1:20],'{}'::uuid[]) where id=v_intent;
  end if;
  perform dek.enqueue_intent('message', v_msg.org_id, v_msg.id, v_msg.channel_id, null, v_uid, u)
     from unnest(v_new[1:20]) u;
  v_json := dek.message_json(v_msg);
  perform dek.emit_channel(v_msg.channel_id, 'msg.upd', jsonb_build_object('message', v_json));
  return v_json;
end $$;

create or replace function dek.plat_route_message(i dek.notification_intents)
returns table (r_user uuid, r_device uuid, r_quiet boolean, r_title text, r_body text, r_url text,
               r_tag text, r_org uuid, r_org_short text, r_preview text, r_urgency text)
language plpgsql stable security definer set search_path = '' as $$
declare
  m       dek.messages;
  c       dek.channels;
  v_dm    boolean;
  v_org   text;
  v_title text;
  v_text  text;
  v_empty text;
  v_links boolean;
begin
  select * into m from dek.messages x where x.id = i.message_id;
  if not found or m.deleted_at is not null or m.kind <> 'user' or m.author_id is null then
    return;   -- deleted before dispatch, or a system line: nothing to say
  end if;
  select * into c from dek.channels x where x.id = m.channel_id;
  v_dm := c.kind in ('dm', 'group_dm');
  select coalesce(o.short_name, o.name) into v_org from dek.orgs o where o.id = m.org_id;
  select case c.kind when 'dm' then a.name when 'group_dm' then a.name || ' in a group message'
                     else a.name || ' in #' || c.name end
    into v_title
    from (select coalesce((select case when p.deleted_at is null then p.display_name else 'Deleted user' end
                             from dek.profiles p where p.id = m.author_id), 'Someone') as name) a;
  v_empty := case when m.attachment_count > 0 then 'Sent an attachment' else 'New message' end;
  -- Rendered once; a body with channel links is rendered per recipient instead, so a
  -- channel name shows only to people who can read that channel.
  v_links := m.body ~ '<#[0-9a-fA-F-]{36}>';
  v_text := coalesce(nullif(dek.plat_render_body(m.body, m.org_id), ''), v_empty);
  return query
  with cand as (
    select cm.user_id as uid from dek.channel_members cm where cm.channel_id = m.channel_id
    union
    select tf.user_id from dek.thread_follows tf
     where m.thread_root_id is not null and tf.root_id = m.thread_root_id and tf.following
  ), who as (
    select x.uid,
           coalesce(n.preview, 'full') as preview,
           coalesce(n.thread_replies, true) as thread_replies,
           n.quiet_start, n.quiet_end, n.quiet_tz,
           case when coalesce(cm.notify, 'default') <> 'default' then cm.notify
                when v_dm then coalesce(n.dm_level, 'all')
                else coalesce(n.default_level, 'mentions') end as level,
           cm.muted_until,
           coalesce(cm.last_read_seq, 0) as read_seq,
           coalesce(tf.following, false) as follows,
           dek.thread_read_seq(x.uid, m.thread_root_id) as read_reply_seq,
           x.uid = any (m.mentions) as direct
      from cand x
      join dek.profiles p on p.id = x.uid and p.deleted_at is null
      left join dek.notification_prefs n on n.user_id = x.uid
      left join dek.channel_members cm on cm.channel_id = m.channel_id and cm.user_id = x.uid
      left join dek.thread_follows tf on tf.root_id = m.thread_root_id and tf.user_id = x.uid
     where x.uid <> m.author_id
       and (i.target_user_id is null or x.uid = i.target_user_id)
       and not (x.uid = any(i.exclude_user_ids))
       and (i.target_user_id is not null or not exists (
         select 1 from dek.notification_intents ni where ni.kind='message' and ni.message_id=m.id
           and ni.target_user_id=x.uid and ni.created_at>=i.created_at))
       and not exists (select 1 from dek.user_blocks b where b.blocker_id = x.uid and b.blocked_id = m.author_id)
       and dek.can_read_channel(x.uid, m.channel_id)
  ), wanted as materialized (
    select w.*,
           case when w.preview <> 'full' then 'New message'
                when v_links then coalesce(nullif(dek.plat_render_body(m.body, m.org_id, w.uid), ''), v_empty)
                else v_text end as body_text
      from who w
     where w.level <> 'none'
       and ((w.level = 'all' and (v_dm or m.in_timeline))
            or w.direct or m.mention_all
            or (m.thread_root_id is not null and w.follows and w.thread_replies))
       and (w.muted_until is null or w.muted_until <= now() or w.direct)
       -- an intent aimed at one person (a mention added by an edit) skips the read check
       and (i.target_user_id is not null
            or not ((m.in_timeline and w.read_seq >= m.seq)
                    or (m.thread_root_id is not null and w.read_reply_seq >= m.seq)))
  )
  select w.uid, d.id,
         case when w.quiet_start is not null and w.quiet_end is not null
              then dek.plat_in_quiet_hours(w.quiet_start, w.quiet_end, w.quiet_tz) else false end,
         case when w.preview = 'none' then 'Dek' else v_title end,
         w.body_text,
         '/o/' || m.org_id || '/c/' || m.channel_id || coalesce('/t/' || m.thread_root_id, '') || '/m/' || m.id,
         coalesce('t:' || m.thread_root_id, 'c:' || m.channel_id),
         m.org_id, v_org, w.preview,
         case when w.direct or m.mention_all then 'high' else 'normal' end
    from wanted w
    join dek.push_devices d on d.user_id = w.uid and d.enabled and d.revoked_at is null
   where not exists (select 1 from dek.notification_deliveries nd
                      where nd.intent_id = i.id and nd.device_id = d.id
                        and not dek.plat_retryable(nd.status, nd.http_status))
   order by w.uid, d.id
   limit 5000;
end $$;
