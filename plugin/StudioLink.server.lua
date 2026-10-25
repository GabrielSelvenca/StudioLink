--!nocheck
--[[
	StudioLink — plugin do Roblox Studio
	Liga o Studio ao server.js local (bridge/server.js) para o Claude Code:
	  • executar qualquer Luau no Studio (edit, ou server/client durante playtest)
	  • sincronizar scripts com a pasta src/ nos dois sentidos
	  • ler o Output, controlar Run/Play
	Instalação: copie este arquivo para %LOCALAPPDATA%\Roblox\Plugins
]]

local VERSION = "1.5.2"
local DEFAULT_PORT = 34880

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local LogService = game:GetService("LogService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local ScriptEditorService = game:GetService("ScriptEditorService")

local ROLE = RunService:IsEdit() and "edit" or (RunService:IsServer() and "server" or "client")

local SYNC_SERVICES = {
	"Workspace", "ReplicatedStorage", "ReplicatedFirst", "ServerScriptService", "ServerStorage",
	"StarterGui", "StarterPack", "StarterPlayer", "Lighting", "SoundService", "TextChatService",
}

local relayFn, relayLog -- relay server <-> client (definidos lá embaixo)
local SID = string.sub(HttpService:GenerateGUID(false), 1, 8)
local alive = true
local connected = false
-- Cada place guarda a própria porta e se está ligado (vários Studios, cada um num projeto).
local PLACE_KEY = game.PlaceId ~= 0 and tostring(game.PlaceId) or ("local:" .. game.Name)
local function loadPlaces()
	local all = plugin:GetSetting("StudioLinkPlaces")
	return type(all) == "table" and all or {}
end
local port, enabled
do
	local all = loadPlaces()
	local c = all[PLACE_KEY]
	if not c and ROLE == "edit" and plugin:GetSetting("StudioLinkEnabled") == true and not plugin:GetSetting("StudioLinkMigrated") then
		c = { port = DEFAULT_PORT, enabled = true } -- migração da versão antiga (botão global)
		plugin:SetSetting("StudioLinkMigrated", true)
	end
	-- A porta mora no próprio place (atributo no Workspace; o playtest copia o place). Os settings do plugin são
	-- compartilhados entre Studios abertos: um regrava a tabela do outro, e o "Last" mandava o teste pro servidor errado.
	if workspace:GetAttribute("StudioLinkPort") then
		c = { port = workspace:GetAttribute("StudioLinkPort"), enabled = true }
	end
	if not c and ROLE ~= "edit" then c = plugin:GetSetting("StudioLinkLast") end -- playtest de place não publicado
	c = type(c) == "table" and c or {}
	port = tonumber(c.port) or DEFAULT_PORT
	enabled = c.enabled == true
end
local function markPort()
	if ROLE == "edit" then workspace:SetAttribute("StudioLinkPort", enabled and port or nil) end
end
markPort()
local function savePlace()
	local all = loadPlaces()
	all[PLACE_KEY] = { port = port, enabled = enabled }
	plugin:SetSetting("StudioLinkPlaces", all)
	plugin:SetSetting("StudioLinkLast", { port = port, enabled = enabled })
	markPort()
end

-- estado pro painel
local state = { conflict = nil, info = nil, lastCmd = nil, lastCmdAt = 0, lastError = nil, pending = nil }

local function say(msg)
	print("[StudioLink] " .. msg)
end

------------------------------------------------------------------ HTTP
local function request(method, path, body)
	local ok, res = pcall(HttpService.RequestAsync, HttpService, {
		Url = "http://localhost:" .. port .. path,
		Method = method,
		Headers = { ["Content-Type"] = "application/json", ["X-Bridge"] = "1" },
		Body = body ~= nil and HttpService:JSONEncode(body) or nil,
	})
	if not ok then return nil, tostring(res) end
	if not res.Success then return nil, res.StatusCode .. " " .. res.Body, res.StatusCode end
	if res.Body == "" then return true end
	local okDecode, data = pcall(HttpService.JSONDecode, HttpService, res.Body)
	if not okDecode then return nil, "json inválido" end
	return data
end

------------------------------------------------------------------ utilidades
local function instPath(inst)
	if inst == game then return "game" end
	local parts = {}
	local cur = inst
	while cur and cur ~= game do
		table.insert(parts, 1, cur.Name)
		cur = cur.Parent
	end
	local p = table.concat(parts, "/")
	if cur ~= game then p = "(fora do jogo)/" .. p end
	return p
end

local function ser(v, depth, seen)
	local t = typeof(v)
	if t == "nil" then return "nil" end
	if t == "boolean" or t == "string" then return v end
	if t == "number" then
		if v ~= v or v == math.huge or v == -math.huge then return tostring(v) end
		return v
	end
	if t == "Instance" then return v.ClassName .. " " .. instPath(v) end
	if t == "EnumItem" then return tostring(v) end
	if t == "table" then
		depth = depth or 0
		seen = seen or {}
		if seen[v] then return "<ciclo>" end
		if depth >= 5 then return "<tabela>" end
		seen[v] = true
		local n, count, isArray = #v, 0, true
		for k in pairs(v) do
			count += 1
			if type(k) ~= "number" or k < 1 or k > n or k % 1 ~= 0 then isArray = false end
		end
		local out = {}
		if isArray and count == n then
			for i = 1, n do out[i] = ser(v[i], depth + 1, seen) end
		else
			for k, val in pairs(v) do out[tostring(k)] = ser(val, depth + 1, seen) end
		end
		seen[v] = nil
		return out
	end
	return t .. "(" .. tostring(v) .. ")"
end

local function resolve(p)
	if typeof(p) == "Instance" then return p end
	if p == nil or p == "" or p == "game" then return game end
	local cur = game
	for seg in string.gmatch(p, "[^/]+") do
		local nxt
		if cur == game then
			nxt = game:FindFirstChild(seg)
			if not nxt then
				local ok, s = pcall(game.GetService, game, seg)
				if ok then nxt = s end
			end
		else
			nxt = cur:FindFirstChild(seg)
		end
		if not nxt then return nil, "não achei '" .. seg .. "' em " .. instPath(cur) end
		cur = nxt
	end
	return cur
end

local function tree(root, maxDepth, maxLines)
	maxDepth = maxDepth or 2
	maxLines = maxLines or 1500
	local lines = {}
	local function visit(inst, depth)
		if #lines >= maxLines then return end
		local okC, children = pcall(inst.GetChildren, inst)
		if not okC then children = {} end
		local line = string.rep("  ", depth) .. inst.Name .. " [" .. inst.ClassName .. "]"
		if depth >= maxDepth and #children > 0 then line ..= " (+" .. #children .. ")" end
		table.insert(lines, line)
		if depth < maxDepth then
			for _, c in ipairs(children) do visit(c, depth + 1) end
		end
	end
	visit(root, 0)
	if #lines >= maxLines then table.insert(lines, "... (cortado em " .. maxLines .. " linhas)") end
	return table.concat(lines, "\n")
end

-- Helpers disponíveis como `B` no código executado
local B = {}
function B.get(p)
	local inst, err = resolve(p)
	if not inst then error(err, 2) end
	return inst
end
B.path = instPath
function B.tree(p, depth)
	return tree(B.get(p), depth)
end
function B.make(className, props, parent)
	local inst = Instance.new(className)
	local par = parent
	for k, v in pairs(props or {}) do
		if k == "Parent" then par = par or v else inst[k] = v end
	end
	if par then inst.Parent = typeof(par) == "Instance" and par or B.get(par) end
	return inst
end
function B.find(root, query)
	local out = {}
	for _, d in ipairs(B.get(root):GetDescendants()) do
		if d.Name == query or d:IsA(query) then table.insert(out, d) end
	end
	return out
end
function B.clear(p)
	for _, c in ipairs(B.get(p):GetChildren()) do c.Parent = nil end
end

------------------------------------------------------------------ objetos por JSON (create/set/get/delete/clone)
--[[
	Formato:
	{ "class": "Part", "name": "Chao", "props": { "Size": [50,1,50], "Color": "#33aa77", "Anchored": true,
	  "Material": "Grass", "CFrame": { "pos": [0,0,0], "rot": [0,45,0] } },
	  "attributes": { "Vida": 100 }, "tags": ["Chao"], "children": [ { "class": "PointLight" } ] }

	Valores: Vector3/Vector2 [x,y,z] · Color3 "#hex", [r,g,b] 0-255 ou nome de BrickColor · UDim2 [xs,xo,ys,yo]
	UDim [s,o] · CFrame [x,y,z] ou {pos,rot(graus)} ou {pos,lookAt} · Enum "Neon" · Font "FredokaOne" ou {family,weight,style}
	NumberRange [min,max] · NumberSequence n ou [[t,v],...] · ColorSequence "#hex" ou [[t,"#hex"],...]
	Rect [x0,y0,x1,y1] · PhysicalProperties [densidade,atrito,elasticidade] · referência a objeto "@Workspace/Peça"
]]
local Obj = {}

local function round(n)
	if n ~= n then return 0 end
	return math.round(n * 10000) / 10000
end

local function nums(v, n, name)
	if type(v) == "number" then
		local t = {}
		for i = 1, n do t[i] = v end
		return t
	end
	if type(v) ~= "table" then error(name .. ": esperava lista de " .. n .. " números", 0) end
	local keys = { "x", "y", "z", "w" }
	local t = {}
	for i = 1, n do
		t[i] = tonumber(v[i] or v[keys[i]] or v[string.upper(keys[i])])
		if not t[i] then error(name .. ": esperava " .. n .. " números", 0) end
	end
	return t
end

local function toColor3(v)
	if typeof(v) == "Color3" then return v end
	if type(v) == "string" then
		local hex = v:gsub("^#", "")
		if hex:match("^%x%x%x%x%x%x$") then return Color3.fromHex(hex) end
		local ok, bc = pcall(BrickColor.new, v)
		if ok and bc.Name == v then return bc.Color end
		error("cor inválida: " .. v .. " (use #hex, [r,g,b] ou nome de BrickColor)", 0)
	end
	if type(v) == "table" then
		local c = nums(v, 3, "Color3")
		if c[1] > 1 or c[2] > 1 or c[3] > 1 then return Color3.fromRGB(c[1], c[2], c[3]) end
		return Color3.new(c[1], c[2], c[3])
	end
	error("Color3 inválido", 0)
end

local function toCFrame(v)
	if type(v) ~= "table" then error("CFrame: use [x,y,z] ou {pos,rot}", 0) end
	if #v == 12 then return CFrame.new(table.unpack(v)) end
	if #v == 3 then return CFrame.new(v[1], v[2], v[3]) end
	local pos = v.pos or v.position or { 0, 0, 0 }
	local p = Vector3.new(table.unpack(nums(pos, 3, "CFrame.pos")))
	if v.lookAt then
		return CFrame.lookAt(p, Vector3.new(table.unpack(nums(v.lookAt, 3, "CFrame.lookAt"))))
	end
	local r = v.rot and nums(v.rot, 3, "CFrame.rot") or { 0, 0, 0 }
	return CFrame.new(p) * CFrame.fromOrientation(math.rad(r[1]), math.rad(r[2]), math.rad(r[3]))
end

local function toFont(v)
	if typeof(v) == "Font" then return v end
	if type(v) == "string" then
		if v:find("^rbxasset") then return Font.new(v) end
		local ok, f = pcall(Font.fromName, v)
		if ok then return f end
		local okE, e = pcall(function() return Enum.Font[v] end)
		if okE and e then return Font.fromEnum(e) end
		error("fonte inválida: " .. v, 0)
	end
	local base = toFont(v.family or "BuilderSans")
	local w = v.weight and Enum.FontWeight[v.weight] or base.Weight
	local s = v.style and Enum.FontStyle[v.style] or base.Style
	return Font.new(base.Family, w, s)
end

local function seq(v, kind)
	if kind == "NumberSequence" then
		if type(v) == "number" then return NumberSequence.new(v) end
		local kps = {}
		for _, k in ipairs(v) do
			table.insert(kps, NumberSequenceKeypoint.new(k[1], k[2], k[3] or 0))
		end
		return NumberSequence.new(kps)
	else
		if type(v) == "string" or (type(v) == "table" and type(v[1]) == "number") then
			return ColorSequence.new(toColor3(v))
		end
		local kps = {}
		for _, k in ipairs(v) do
			table.insert(kps, ColorSequenceKeypoint.new(k[1], toColor3(k[2])))
		end
		return ColorSequence.new(kps)
	end
end

local function resolveRef(p)
	local inst, err = resolve(p)
	if not inst then error(err, 0) end
	return inst
end

-- converte o valor JSON pro tipo que a propriedade espera (descoberto pelo valor atual)
function Obj.decode(inst, prop, v)
	if type(v) == "string" and v:sub(1, 1) == "@" then
		return resolveRef(v:sub(2))
	end
	if v == nil or v == "nil" then return nil end
	local ok, cur = pcall(function() return inst[prop] end)
	if not ok then error(inst.ClassName .. " não tem a propriedade " .. prop, 0) end
	local t = typeof(cur)
	if t == "Vector3" then return Vector3.new(table.unpack(nums(v, 3, prop))) end
	if t == "Vector2" then return Vector2.new(table.unpack(nums(v, 2, prop))) end
	if t == "Color3" then return toColor3(v) end
	if t == "BrickColor" then return type(v) == "string" and BrickColor.new(v) or BrickColor.new(toColor3(v)) end
	if t == "UDim2" then
		if type(v) == "table" and (v.scale or v.offset) then
			local s, o = nums(v.scale or { 0, 0 }, 2, prop), nums(v.offset or { 0, 0 }, 2, prop)
			return UDim2.new(s[1], o[1], s[2], o[2])
		end
		return UDim2.new(table.unpack(nums(v, 4, prop)))
	end
	if t == "UDim" then return UDim.new(table.unpack(nums(v, 2, prop))) end
	if t == "CFrame" then return toCFrame(v) end
	if t == "EnumItem" then
		local okE, item = pcall(function() return cur.EnumType[tostring(v)] end)
		if not okE or not item then error("valor inválido '" .. tostring(v) .. "' (é um " .. tostring(cur.EnumType) .. ")", 0) end
		return item
	end
	if t == "Font" then return toFont(v) end
	if t == "NumberRange" then
		if type(v) == "number" then return NumberRange.new(v) end
		return NumberRange.new(v[1], v[2] or v[1])
	end
	if t == "NumberSequence" or t == "ColorSequence" then return seq(v, t) end
	if t == "Rect" then return Rect.new(table.unpack(nums(v, 4, prop))) end
	if t == "PhysicalProperties" or (t == "nil" and prop == "CustomPhysicalProperties") then
		if v == "default" then return nil end
		return PhysicalProperties.new(table.unpack(v))
	end
	if t == "Content" and type(v) == "string" then
		local okC, c = pcall(Content.fromUri, v)
		if okC then return c end
	end
	if t == "number" and type(v) == "string" then return tonumber(v) end
	return v
end

local function hex(c) -- algumas cores antigas passam de 1.0; o ToHex reclama
	return "#" .. Color3.new(math.clamp(c.R, 0, 1), math.clamp(c.G, 0, 1), math.clamp(c.B, 0, 1)):ToHex()
end

-- valor Roblox -> JSON (inverso do decode)
function Obj.encode(v)
	local t = typeof(v)
	if t == "nil" or t == "boolean" or t == "string" then return v end
	if t == "number" then return round(v) end
	if t == "Vector3" then return { round(v.X), round(v.Y), round(v.Z) } end
	if t == "Vector2" then return { round(v.X), round(v.Y) } end
	if t == "Color3" then return hex(v) end
	if t == "BrickColor" then return v.Name end
	if t == "UDim2" then return { round(v.X.Scale), round(v.X.Offset), round(v.Y.Scale), round(v.Y.Offset) } end
	if t == "UDim" then return { round(v.Scale), round(v.Offset) } end
	if t == "CFrame" then
		local rx, ry, rz = v:ToOrientation()
		return { pos = Obj.encode(v.Position), rot = { round(math.deg(rx)), round(math.deg(ry)), round(math.deg(rz)) } }
	end
	if t == "EnumItem" then return v.Name end
	if t == "Font" then
		local family = v.Family:match("families/(.-)%.json$") or v.Family
		if v.Weight == Enum.FontWeight.Regular and v.Style == Enum.FontStyle.Normal then return family end
		return { family = family, weight = v.Weight.Name, style = v.Style.Name }
	end
	if t == "NumberRange" then return { round(v.Min), round(v.Max) } end
	if t == "NumberSequence" then
		local out = {}
		for _, k in ipairs(v.Keypoints) do table.insert(out, { round(k.Time), round(k.Value), round(k.Envelope) }) end
		return out
	end
	if t == "ColorSequence" then
		local out = {}
		for _, k in ipairs(v.Keypoints) do table.insert(out, { round(k.Time), hex(k.Value) }) end
		return out
	end
	if t == "Rect" then return { round(v.Min.X), round(v.Min.Y), round(v.Max.X), round(v.Max.Y) } end
	if t == "PhysicalProperties" then return { round(v.Density), round(v.Friction), round(v.Elasticity) } end
	if t == "Instance" then return "@" .. instPath(v) end
	if t == "Content" then return v.Uri or "" end
	return tostring(v)
end

-- propriedades que o get olha (só aparecem as que existem na classe e estão fora do padrão)
local CANDIDATES = {
	-- partes
	"Anchored", "CanCollide", "CanTouch", "CanQuery", "CastShadow", "Massless", "Locked", "Shape", "Size", "CFrame",
	"Color", "Material", "MaterialVariant", "Transparency", "Reflectance", "TopSurface", "BottomSurface",
	"MeshId", "TextureID", "CollisionFidelity", "RenderFidelity", "CustomPhysicalProperties", "UsePartColor",
	"PrimaryPart", "WorldPivot", "LevelOfDetail", "ModelStreamingMode",
	-- UI
	"Enabled", "ResetOnSpawn", "IgnoreGuiInset", "ZIndexBehavior", "DisplayOrder", "ScreenInsets",
	"AnchorPoint", "Position", "Size", "Rotation", "Visible", "ZIndex", "LayoutOrder", "ClipsDescendants",
	"AutomaticSize", "BackgroundColor3", "BackgroundTransparency", "BorderSizePixel", "Active", "Selectable",
	"Text", "RichText", "FontFace", "TextSize", "TextColor3", "TextTransparency", "TextScaled", "TextWrapped",
	"TextXAlignment", "TextYAlignment", "TextStrokeColor3", "TextStrokeTransparency", "TextTruncate", "LineHeight",
	"PlaceholderText", "ClearTextOnFocus", "AutoButtonColor",
	"Image", "ImageColor3", "ImageTransparency", "ScaleType", "SliceCenter", "TileSize", "ImageRectOffset", "ImageRectSize",
	"CanvasSize", "AutomaticCanvasSize", "ScrollBarThickness", "ScrollingDirection",
	"CornerRadius", "Thickness", "ApplyStrokeMode", "LineJoinMode", "Rotation", "Offset", "Scale", "AspectRatio",
	"Padding", "PaddingTop", "PaddingBottom", "PaddingLeft", "PaddingRight", "FillDirection", "HorizontalAlignment",
	"VerticalAlignment", "SortOrder", "CellSize", "CellPadding", "Wraps", "MaxSize", "MinSize",
	"StudsOffset", "StudsOffsetWorldSpace", "AlwaysOnTop", "MaxDistance", "LightInfluence", "Face", "SizingMode",
	"PixelsPerStud", "CanvasSize", "Adornee",
	-- luz, efeitos, som
	"Brightness", "Range", "Shadows", "Angle", "Color", "Rate", "Lifetime", "Speed", "SpreadAngle", "Texture",
	"LightEmission", "Acceleration", "Drag", "EmissionDirection", "RotSpeed", "Orientation", "ZOffset", "LockedToPart",
	"SparkleColor", "Heat", "SecondaryColor", "Opacity", "RiseVelocity",
	"Attachment0", "Attachment1", "Width0", "Width1", "FaceCamera", "Segments", "CurveSize0", "CurveSize1", "TextureLength",
	"TextureMode", "TextureSpeed", "MinLength", "MaxLength", "WidthScale",
	"SoundId", "Volume", "Looped", "PlaybackSpeed", "RollOffMaxDistance", "RollOffMinDistance", "PlayOnRemove",
	"StudsPerTileU", "StudsPerTileV", "OffsetStudsU", "OffsetStudsV", "Color3",
	-- outros
	"Value", "Part0", "Part1", "C0", "C1", "MaxVelocity", "DesiredAngle", "Visible",
	"Ambient", "OutdoorAmbient", "ClockTime", "FogEnd", "FogStart", "FogColor", "GlobalShadows", "ExposureCompensation",
	"Density", "Haze", "Glare", "Decay", "Intensity", "Threshold", "Contrast", "Saturation", "TintColor",
}
do
	local seen, list = {}, {}
	for _, n in ipairs(CANDIDATES) do
		if not seen[n] then seen[n] = true; table.insert(list, n) end
	end
	CANDIDATES = list
end

local defaults = {}
local function defaultOf(className)
	if defaults[className] == nil then
		local ok, inst = pcall(Instance.new, className)
		defaults[className] = ok and inst or false
	end
	return defaults[className] or nil
end

local function same(a, b)
	if typeof(a) ~= typeof(b) then return false end
	if typeof(a) == "number" then return math.abs(a - b) < 1e-4 end
	if typeof(a) == "CFrame" then return a:FuzzyEq(b, 1e-4) end
	return a == b
end

function Obj.serialize(inst, depth, onlyProps)
	local node = { class = inst.ClassName, name = inst.Name }
	local props = {}
	local def = defaultOf(inst.ClassName)
	for _, p in ipairs(onlyProps or CANDIDATES) do
		local ok, v = pcall(function() return inst[p] end)
		if ok and typeof(v) ~= "RBXScriptSignal" and typeof(v) ~= "function" then
			local include = onlyProps ~= nil
			if not include then
				if def then
					local okD, dv = pcall(function() return def[p] end)
					include = not okD or not same(v, dv)
				else
					include = v ~= nil
				end
			end
			-- em partes, Position/Orientation/Rotation repetem o CFrame; Sparkles.Color é o antigo SparkleColor
			local redundant = (inst:IsA("BasePart") and (p == "Position" or p == "Orientation" or p == "Rotation"))
				or (inst:IsA("Sparkles") and p == "Color")
			if include and not redundant and not onlyProps then props[p] = Obj.encode(v) end
			if onlyProps then props[p] = Obj.encode(v) end
		end
	end
	if next(props) then node.props = props end
	local attrs = inst:GetAttributes()
	if next(attrs) then
		node.attributes = {}
		for k, v in pairs(attrs) do node.attributes[k] = Obj.encode(v) end
	end
	local tags = game:GetService("CollectionService"):GetTags(inst)
	if #tags > 0 then node.tags = tags end
	local kids = inst:GetChildren()
	if #kids > 0 then
		if (depth or 0) > 0 then
			node.children = {}
			for _, c in ipairs(kids) do table.insert(node.children, Obj.serialize(c, depth - 1, nil)) end
		else
			node.childCount = #kids
		end
	end
	return node
end

local function applyProps(inst, spec)
	local errs = {}
	-- Parent e CFrame por último (Size antes de CFrame; não reparentar antes de configurar)
	local later = {}
	for k, v in pairs(spec.props or {}) do
		if k == "Parent" or k == "CFrame" or k == "Position" and inst:IsA("BasePart") or k == "PrimaryPart" then
			later[k] = v
		else
			local ok, err = pcall(function() inst[k] = Obj.decode(inst, k, v) end)
			if not ok then table.insert(errs, k .. ": " .. tostring(err)) end
		end
	end
	for _, k in ipairs({ "PrimaryPart", "CFrame", "Position" }) do
		if later[k] ~= nil then
			local ok, err = pcall(function() inst[k] = Obj.decode(inst, k, later[k]) end)
			if not ok then table.insert(errs, k .. ": " .. tostring(err)) end
		end
	end
	-- pivot: move o objeto inteiro (Model ou parte). Sem "rot"/"lookAt" mantém a rotação atual.
	-- move: [dx,dy,dz] desloca a partir de onde está.
	if (spec.pivot or spec.move) and (inst:IsA("Model") or inst:IsA("BasePart")) then
		local ok, err = pcall(function()
			local cur = inst:GetPivot()
			local target = cur
			if spec.pivot then
				local pv = spec.pivot
				local keepRot = type(pv) == "table" and (#pv == 3 or (pv.rot == nil and pv.lookAt == nil))
				target = toCFrame(pv)
				if keepRot then target = CFrame.new(target.Position) * cur.Rotation end
			end
			if spec.move then target = target + Vector3.new(table.unpack(nums(spec.move, 3, "move"))) end
			inst:PivotTo(target)
		end)
		if not ok then table.insert(errs, "pivot: " .. tostring(err)) end
	end
	for k, v in pairs(spec.attributes or {}) do
		local ok, err = pcall(function()
			if type(v) == "string" and v:match("^#%x%x%x%x%x%x$") then v = toColor3(v) end
			inst:SetAttribute(k, v)
		end)
		if not ok then table.insert(errs, "atributo " .. k .. ": " .. tostring(err)) end
	end
	for _, tag in ipairs(spec.tags or {}) do inst:AddTag(tag) end
	if spec.name then inst.Name = spec.name end
	return errs, later.Parent
end

local function build(spec, parent, errs, created)
	if type(spec) ~= "table" or type(spec.class) ~= "string" then error("cada objeto precisa de \"class\"", 0) end
	local ok, inst = pcall(Instance.new, spec.class)
	if not ok then error("classe inválida: " .. spec.class, 0) end
	inst.Name = spec.name or spec.class
	local e, parentRef = applyProps(inst, spec)
	for _, m in ipairs(e) do table.insert(errs, inst.Name .. "." .. m) end
	for _, child in ipairs(spec.children or {}) do build(child, inst, errs, nil) end
	if spec.source and inst:IsA("LuaSourceContainer") then inst.Source = spec.source end
	inst.Parent = parentRef and Obj.decode(inst, "Parent", parentRef) or parent
	if created then table.insert(created, inst) end
	return inst
end

local function rec(name, fn)
	local r = (ROLE == "edit" and not RunService:IsRunning()) and select(2, pcall(ChangeHistoryService.TryBeginRecording, ChangeHistoryService, name)) or nil
	local ok, res = pcall(fn)
	if r then pcall(ChangeHistoryService.FinishRecording, ChangeHistoryService, r, Enum.FinishRecordingOperation.Commit) end
	if not ok then error(res, 0) end
	return res
end

function Obj.create(cmd)
	return rec("Claude: create", function()
		local parent = game.Workspace
		if cmd.parent then
			local p, err = resolve(cmd.parent)
			if not p then error(err, 0) end
			parent = p
		end
		local specs = cmd.spec
		if specs.class then specs = { specs } end
		local errs, created = {}, {}
		for _, spec in ipairs(specs) do
			if cmd.replace and spec.name then
				local old = parent:FindFirstChild(spec.name)
				if old then old:Destroy() end
			end
			build(spec, parent, errs, created)
		end
		local paths = {}
		for _, inst in ipairs(created) do table.insert(paths, instPath(inst)) end
		if cmd.select ~= false and ROLE == "edit" then pcall(function() game:GetService("Selection"):Set(created) end) end
		return { ok = #errs == 0, created = paths, error = #errs > 0 and ("alguns valores falharam:\n" .. table.concat(errs, "\n")) or nil }
	end)
end

function Obj.set(cmd)
	return rec("Claude: set", function()
		local inst, err = resolve(cmd.path)
		if not inst then error(err, 0) end
		local errs, parentRef = applyProps(inst, cmd)
		if parentRef then inst.Parent = Obj.decode(inst, "Parent", parentRef) end
		return { ok = #errs == 0, path = instPath(inst), error = #errs > 0 and table.concat(errs, "\n") or nil }
	end)
end

function Obj.get(cmd)
	local inst, err = resolve(cmd.path)
	if not inst then return { ok = false, error = err } end
	if inst == game then return { ok = false, error = "use um caminho, ex.: Workspace/Peça" } end
	return { ok = true, object = Obj.serialize(inst, tonumber(cmd.depth) or 0, cmd.props) }
end

function Obj.delete(cmd)
	return rec("Claude: delete", function()
		local paths = type(cmd.path) == "table" and cmd.path or { cmd.path }
		local removed = {}
		for _, p in ipairs(paths) do
			local inst, err = resolve(p)
			if not inst then error(err, 0) end
			if inst.Parent == game or inst == game then error("não dá pra apagar um serviço: " .. p, 0) end
			table.insert(removed, instPath(inst))
			inst:Destroy()
		end
		return { ok = true, deleted = removed }
	end)
end

function Obj.clone(cmd)
	return rec("Claude: clone", function()
		local inst, err = resolve(cmd.path)
		if not inst then error(err, 0) end
		local copy = inst:Clone()
		if not copy then error("objeto não pode ser clonado (Archivable = false?)", 0) end
		if cmd.name then copy.Name = cmd.name end
		local parent = inst.Parent
		if cmd.parent then
			local p, perr = resolve(cmd.parent)
			if not p then error(perr, 0) end
			parent = p
		end
		if cmd.props then applyProps(copy, cmd) end
		copy.Parent = parent
		return { ok = true, created = { instPath(copy) } }
	end)
end

------------------------------------------------------------------ executar Luau
local function beginRec(name)
	if ROLE ~= "edit" or RunService:IsRunning() then return nil end
	local ok, rec = pcall(ChangeHistoryService.TryBeginRecording, ChangeHistoryService, name)
	return ok and rec or nil
end
local function endRec(rec)
	if rec then pcall(ChangeHistoryService.FinishRecording, ChangeHistoryService, rec, Enum.FinishRecordingOperation.Commit) end
end

-- loadstring não existe nos DataModels do playtest; lá o código vira um ModuleScript temporário.
local function compile(code, name)
	local okLs, fn, cerr = pcall(loadstring, code, "=" .. name)
	if okLs then
		if not fn then return nil, "erro de compilação: " .. tostring(cerr) end
		return function(env)
			setfenv(fn, env)
			return fn
		end
	end
	return function(env)
		local m = Instance.new("ModuleScript")
		m.Name = name
		m.Source = "return function(print, warn, B, plugin) " .. code .. "\nend" -- mesma linha: números de linha batem
		m.Archivable = false
		local okP = pcall(function() m.Parent = game:GetService("CoreGui") end)
		if not okP then m.Parent = nil end
		local okR, factory = pcall(require, m)
		m:Destroy()
		if not okR or type(factory) ~= "function" then
			local detail = tostring(factory)
			task.wait() -- deixa a mensagem chegar no LogService
			local hist = LogService:GetLogHistory()
			for i = #hist, math.max(1, #hist - 30), -1 do
				local msg = hist[i].message
				if string.find(msg, name .. ":", 1, true) then
					detail = (msg:gsub("^CoreGui%.", ""))
					break
				end
			end
			error("erro de compilação: " .. detail, 0)
		end
		-- o módulo devolve uma função que recebe os helpers
		return nil, factory
	end
end

local runCounter = 0
local function cleanTrace(msg)
	local out = {}
	for line in string.gmatch(tostring(msg), "[^\n]+") do
		if not string.find(line, "user_StudioLink", 1, true) then
			table.insert(out, (line:gsub("CoreGui%.", "")))
		end
	end
	return table.concat(out, "\n")
end

local function runCode(code, name)
	runCounter += 1
	name = tostring(name or "claude"):gsub("[^%w_]", "_") .. "_" .. runCounter
	local loader, cerr = compile(code, name)
	if not loader then return { ok = false, error = cerr } end

	local output = {}
	local function capture(prefix)
		return function(...)
			local n = select("#", ...)
			local parts = table.create(n)
			for i = 1, n do parts[i] = tostring((select(i, ...))) end
			table.insert(output, prefix .. table.concat(parts, " "))
		end
	end
	local pr, wr = capture(""), capture("[warn] ")

	local rec = beginRec("Claude: " .. name)
	local t0 = os.clock()
	local done, packed = false, nil
	task.spawn(function()
		packed = table.pack(xpcall(function()
			local env = setmetatable({ print = pr, warn = wr, B = B, plugin = plugin }, { __index = getfenv(1) })
			local okL, fn, factory = pcall(loader, env)
			if not okL then error(fn, 0) end
			if fn then return fn() end
			return factory(pr, wr, B, plugin) -- caminho do ModuleScript (playtest)
		end, function(e) return debug.traceback(tostring(e), 2) end))
		done = true
	end)
	while not done do task.wait() end
	endRec(rec)

	local ms = math.floor((os.clock() - t0) * 1000)
	if not packed[1] then
		return { ok = false, error = cleanTrace(packed[2]), output = output, ms = ms }
	end
	local returns = {}
	for i = 2, packed.n do table.insert(returns, ser(packed[i])) end
	return { ok = true, output = output, returns = returns, ms = ms }
end

------------------------------------------------------------------ teste bruteforce (audit_ui, audit_world, fuzz_input) e assets
local Fuzz = {}

local function addIssue(list, kind, where, detail, extra)
	local key = kind .. "|" .. where
	for _, it in ipairs(list) do
		if it.key == key then it.vezes += 1 return end
	end
	local item = { key = key, tipo = kind, onde = where, detalhe = detail, vezes = 1 }
	if extra then for k, v in pairs(extra) do item[k] = v end end
	table.insert(list, item)
end

local function strip(list)
	for _, it in ipairs(list) do it.key = nil end
	return list
end

local function visibleChain(g)
	local cur = g
	while cur and not cur:IsA("LayerCollector") do
		if cur:IsA("GuiObject") and not cur.Visible then return false end
		cur = cur.Parent
	end
	if cur and cur:IsA("ScreenGui") and not cur.Enabled then return false end
	return cur ~= nil
end

local function lum(c)
	return 0.2126 * c.R + 0.7152 * c.G + 0.0722 * c.B
end

-- UI do jogador (rodar no client do playtest)
function Fuzz.auditUI()
	local Players = game:GetService("Players")
	local lp = Players.LocalPlayer
	if not lp then return { ok = false, error = "audit_ui roda no client (target client)" } end
	local gui = lp:FindFirstChildOfClass("PlayerGui")
	local cam = workspace.CurrentCamera
	local vp = cam and cam.ViewportSize or Vector2.new(1920, 1080)
	local inset = game:GetService("GuiService"):GetGuiInset()
	local issues, buttons, checked = {}, {}, 0
	for _, g in ipairs(gui and gui:GetDescendants() or {}) do
		if g:IsA("GuiObject") and visibleChain(g) then
			checked += 1
			local path = instPath(g):gsub("^Players/[^/]+/PlayerGui/", "")
			local size, pos = g.AbsoluteSize, g.AbsolutePosition
			local layer = g:FindFirstAncestorWhichIsA("ScreenGui")
			local top = (layer and layer.IgnoreGuiInset) and 0 or inset.Y
			if size.X < 1 or size.Y < 1 then
				addIssue(issues, "tamanho zero", path, "elemento visível com AbsoluteSize " .. tostring(size))
			else
				local x0, y0, x1, y1 = pos.X, pos.Y + top, pos.X + size.X, pos.Y + top + size.Y
				local outW = math.max(0, -x0) + math.max(0, x1 - vp.X)
				local outH = math.max(0, -y0) + math.max(0, y1 - vp.Y)
				if outW > size.X * 0.2 or outH > size.Y * 0.2 then
					addIssue(issues, "fora da tela", path, ("%.0f%% fora (tela %dx%d)"):format(math.max(outW / size.X, outH / size.Y) * 100, vp.X, vp.Y))
				end
			end
			for _, prop in ipairs({ "Size", "Position" }) do
				local u = g[prop]
				if u.X.Offset ~= 0 or u.Y.Offset ~= 0 then
					addIssue(issues, "usa Offset", path .. " (" .. prop .. ")", prop .. " = " .. tostring(u) .. " (padrão: só Scale)")
				end
			end
			if g:IsA("TextLabel") or g:IsA("TextButton") or g:IsA("TextBox") then
				if g.Text ~= "" and g.TextTransparency < 1 then
					if not g.TextFits and not g.TextScaled and not g.TextWrapped then
						addIssue(issues, "texto cortado", path, "\"" .. g.Text:sub(1, 40) .. "\" não cabe")
					end
					if g.TextScaled and not g:FindFirstChildOfClass("UITextSizeConstraint") then
						addIssue(issues, "texto sem limite", path, "TextScaled sem UITextSizeConstraint (fica gigante em tela grande)")
					end
					local grad = g:FindFirstChildOfClass("UIGradient")
					if grad and grad.Enabled then
						local hasOutline = false
						for _, st in ipairs(g:GetChildren()) do
							if st:IsA("UIStroke") and st.ApplyStrokeMode == Enum.ApplyStrokeMode.Contextual and st.Transparency < 0.5 then hasOutline = true end
						end
						if not hasOutline then
							addIssue(issues, "texto pode sumir", path, "UIGradient tinge o texto junto com o fundo; ponha o texto num TextLabel filho ou um UIStroke Contextual")
						end
					end
					if g.BackgroundTransparency < 0.5 and not grad then
						if math.abs(lum(g.TextColor3) - lum(g.BackgroundColor3)) < 0.25 then
							addIssue(issues, "pouco contraste", path, "cor do texto parecida com o fundo")
						end
					end
				end
			end
			if (g:IsA("ImageLabel") or g:IsA("ImageButton")) and g.Image == "" and g.BackgroundTransparency >= 1 then
				addIssue(issues, "imagem vazia", path, "ImageLabel sem Image e sem fundo (invisível)")
			end
			if g:IsA("GuiButton") and size.X >= 1 then
				table.insert(buttons, { g = g, path = path, pos = pos, size = size })
			end
		end
	end
	for i = 1, #buttons do
		for j = i + 1, #buttons do
			local a, b = buttons[i], buttons[j]
			if a.g.ZIndex == b.g.ZIndex and not a.g:IsAncestorOf(b.g) and not b.g:IsAncestorOf(a.g) then
				local ix = math.max(0, math.min(a.pos.X + a.size.X, b.pos.X + b.size.X) - math.max(a.pos.X, b.pos.X))
				local iy = math.max(0, math.min(a.pos.Y + a.size.Y, b.pos.Y + b.size.Y) - math.max(a.pos.Y, b.pos.Y))
				local smaller = math.min(a.size.X * a.size.Y, b.size.X * b.size.Y)
				if smaller > 0 and ix * iy > smaller * 0.4 then
					addIssue(issues, "botões sobrepostos", a.path .. " + " .. b.path, "um cobre o outro (mesmo ZIndex)")
				end
			end
		end
	end
	return { ok = true, tela = { vp.X, vp.Y }, elementos = checked, botoes = #buttons, problemas = strip(issues) }
end

-- Mundo (rodar no server do playtest ou em edit)
function Fuzz.auditWorld()
	local issues = {}
	local Players = game:GetService("Players")
	local fallen = workspace.FallenPartsDestroyHeight
	local positions, parts, generic = {}, 0, 0
	local spawns = 0
	for _, d in ipairs(workspace:GetDescendants()) do
		local inChar = false
		local model = d:FindFirstAncestorWhichIsA("Model")
		if model and Players:GetPlayerFromCharacter(model) then inChar = true end
		if not inChar then
			if d:IsA("SpawnLocation") then spawns += 1 end
			if d:IsA("BasePart") and not d:IsA("Terrain") then
				parts += 1
				local path = instPath(d)
				if not d.Anchored and #d:GetJoints() == 0 and d.Position.Y < fallen + 60 then
					addIssue(issues, "peça caindo", path, ("solta e caindo (y=%.0f)"):format(d.Position.Y))
				end
				if d.CanCollide and d.Transparency >= 0.99 and d.Name ~= "HumanoidRootPart" then
					addIssue(issues, "parede invisível", path, "Transparency 1 com CanCollide ligado")
				end
				local key = ("%s|%.2f,%.2f,%.2f|%.2f,%.2f,%.2f"):format(d.ClassName, d.Position.X, d.Position.Y, d.Position.Z, d.Size.X, d.Size.Y, d.Size.Z)
				if positions[key] then
					addIssue(issues, "peça duplicada", path, "mesma posição e tamanho que " .. positions[key] .. " (z-fighting)")
				else
					positions[key] = path
				end
				if d.Name == "Part" or d.Name == "MeshPart" or d.Name == "Union" then
					generic += 1
					if generic <= 10 then addIssue(issues, "sem nome", path, "nome genérico") end
				end
			elseif d:IsA("Model") and d.Name == "Model" then
				addIssue(issues, "sem nome", instPath(d), "Model com nome genérico")
			elseif d:IsA("Sound") and d.SoundId == "" then
				addIssue(issues, "som vazio", instPath(d), "Sound sem SoundId")
			end
		end
	end
	if spawns == 0 then addIssue(issues, "sem spawn", "Workspace", "nenhum SpawnLocation") end
	if generic > 10 then addIssue(issues, "sem nome", "Workspace", generic .. " peças com nome genérico no total") end
	return { ok = true, pecas = parts, problemas = strip(issues) }
end

-- Joga sozinho: anda, pula, clica em botões e registra o que der errado (rodar no client do playtest)
function Fuzz.input(cmd)
	local Players = game:GetService("Players")
	local lp = Players.LocalPlayer
	if not lp then return { ok = false, error = "fuzz_input roda no client (target client)" } end
	local seconds = math.clamp(tonumber(cmd.seconds) or 30, 5, 300)
	local rng = Random.new(tonumber(cmd.seed) or os.time())
	local events, actions = {}, { andar = 0, pular = 0, clicar = 0 }
	local vimOk, vim = pcall(game.GetService, game, "VirtualInputManager")
	local canClick = vimOk and vim ~= nil
	local inset = game:GetService("GuiService"):GetGuiInset()
	local fallen = workspace.FallenPartsDestroyHeight

	local function character()
		local c = lp.Character
		local h = c and c:FindFirstChildOfClass("Humanoid")
		local r = c and c:FindFirstChild("HumanoidRootPart")
		if h and r and h.Health > 0 then return c, h, r end
		return nil
	end
	local function waitChar(t)
		local t0 = os.clock()
		while os.clock() - t0 < t do
			local c, h, r = character()
			if c then return c, h, r end
			task.wait(0.2)
		end
		return nil
	end
	local function targets()
		local list = {}
		for _, d in ipairs(workspace:GetDescendants()) do
			if d:IsA("BasePart") and d.CanCollide and d.Transparency < 1 and d.Size.X >= 2 and d.Size.Z >= 2 and d.Size.Y < 60 then
				local m = d:FindFirstAncestorWhichIsA("Model")
				if not (m and Players:GetPlayerFromCharacter(m)) and d.Name ~= "Baseplate" then table.insert(list, d) end
			end
		end
		return list
	end
	local function buttons()
		local list = {}
		local gui = lp:FindFirstChildOfClass("PlayerGui")
		for _, g in ipairs(gui and gui:GetDescendants() or {}) do
			if g:IsA("GuiButton") and visibleChain(g) and g.AbsoluteSize.X > 1 then table.insert(list, g) end
		end
		return list
	end

	local spots = targets()
	local t0 = os.clock()
	local deaths = 0
	local maxButtons = 0
	local _, startHum = waitChar(10)
	if startHum then
		startHum.Died:Connect(function() deaths += 1 end)
		lp.CharacterAdded:Connect(function(c)
			local h = c:WaitForChild("Humanoid", 5)
			if h then h.Died:Connect(function() deaths += 1 end) end
		end)
	end

	while os.clock() - t0 < seconds do
		local c, hum, root = waitChar(6)
		if not c then
			addIssue(events, "personagem não volta", "jogador", "sem personagem vivo por 6s")
			break
		end
		local roll = rng:NextNumber()
		if roll < 0.45 then
			-- anda até uma superfície aleatória (ou um ponto perto)
			local goal
			if #spots > 0 and rng:NextNumber() < 0.7 then
				local p = spots[rng:NextInteger(1, #spots)]
				goal = p.Position + Vector3.new(0, p.Size.Y / 2, 0)
			else
				goal = root.Position + Vector3.new(rng:NextNumber(-30, 30), 0, rng:NextNumber(-30, 30))
			end
			actions.andar += 1
			hum:MoveTo(goal)
			local reached, last, still = false, root.Position, 0
			local conn = hum.MoveToFinished:Connect(function(ok) reached = ok end)
			local s = os.clock()
			while os.clock() - s < 3 and not reached do
				task.wait(0.25)
				if root.Parent == nil then break end
				if (root.Position - last).Magnitude < 0.3 then still += 0.25 else still = 0 end
				last = root.Position
				if still >= 1.5 and hum.FloorMaterial ~= Enum.Material.Air then
					addIssue(events, "travou", ("perto de (%.0f, %.0f, %.0f)"):format(root.Position.X, root.Position.Y, root.Position.Z), "personagem parado tentando andar (algo bloqueando?)")
					hum:ChangeState(Enum.HumanoidStateType.Jumping)
					break
				end
			end
			conn:Disconnect()
		elseif roll < 0.8 then
			actions.pular += 1
			hum:ChangeState(Enum.HumanoidStateType.Jumping)
			task.wait(rng:NextNumber(0.3, 0.9))
		else
			local list = buttons()
			maxButtons = math.max(maxButtons, #list)
			if #list > 0 then
				local b = list[rng:NextInteger(1, #list)]
				local layer = b:FindFirstAncestorWhichIsA("ScreenGui")
				local top = (layer and layer.IgnoreGuiInset) and 0 or inset.Y
				local x = b.AbsolutePosition.X + b.AbsoluteSize.X / 2
				local y = b.AbsolutePosition.Y + b.AbsoluteSize.Y / 2 + top
				actions.clicar += 1
				if canClick then
					local ok = pcall(function()
						vim:SendMouseButtonEvent(x, y, 0, true, game, 1)
						task.wait(0.05)
						vim:SendMouseButtonEvent(x, y, 0, false, game, 1)
					end)
					if not ok then canClick = false end
				end
				task.wait(0.4)
			else
				task.wait(0.2)
			end
		end
		local _, _, r2 = character()
		if r2 and r2.Position.Y < fallen + 30 then
			addIssue(events, "caiu do mapa", ("em (%.0f, %.0f)"):format(r2.Position.X, r2.Position.Z), "personagem abaixo do limite do mundo")
		end
	end
	if deaths > 0 then addIssue(events, "morreu", "jogador", deaths .. " morte(s) durante o teste") end
	return { ok = true, segundos = math.floor(os.clock() - t0), acoes = actions, cliquesReais = canClick,
		superficies = #spots, botoesVisiveis = maxButtons,
		nota = maxButtons == 0 and "nenhum botão visível durante o teste (nada pra clicar)" or nil, eventos = strip(events) }
end

-- Assets: insere um asset do Roblox (modelo, mesh, decal, áudio) pelo id
function Fuzz.insert(cmd)
	local id = tonumber(cmd.assetId)
	if not id then return { ok = false, error = "assetId inválido" } end
	local parent = workspace
	if cmd.parent then
		local p, err = resolve(cmd.parent)
		if not p then return { ok = false, error = err } end
		parent = p
	end
	local ok, model = pcall(function() return game:GetService("InsertService"):LoadAsset(id) end)
	if not ok then return { ok = false, error = "LoadAsset falhou: " .. tostring(model) .. " (o asset é seu e já foi aprovado pela moderação?)" } end
	local created, info = {}, {}
	if cmd.peek then -- só lê os ids (ex.: imagem de um Decal) sem colocar nada no place
		for _, child in ipairs(model:GetDescendants()) do
			if child:IsA("Decal") or child:IsA("Texture") then info.imageUri = child.Texture end
			if child:IsA("MeshPart") then info.meshId = child.MeshID; info.textureId = child.TextureID end
		end
		model:Destroy()
		return { ok = true, info = info }
	end
	local r = beginRec("Claude: insert " .. id)
	for _, child in ipairs(model:GetChildren()) do
		if cmd.name and #model:GetChildren() == 1 then child.Name = cmd.name end
		child.Parent = parent
		-- o import de FBX deixa o MeshPart com PivotOffset girado 90°: zera pra PivotTo/PrimaryPart não deitarem o modelo
		for _, d in ipairs(child:IsA("BasePart") and { child } or child:GetDescendants()) do
			if d:IsA("BasePart") then d.PivotOffset = CFrame.new() end
		end
		if child:IsA("Model") and not child.PrimaryPart then
			child.PrimaryPart = child:FindFirstChildWhichIsA("BasePart", true)
		end
		table.insert(created, instPath(child))
		if child:IsA("Decal") or child:IsA("Texture") then info.imageUri = child.Texture end
		if child:IsA("MeshPart") then info.meshId = child.MeshID; info.textureId = child.TextureID end
	end
	endRec(r)
	model:Destroy()
	if cmd.pivot then
		for _, p in ipairs(created) do
			local inst = resolve(p)
			if inst and (inst:IsA("Model") or inst:IsA("BasePart")) then pcall(function() inst:PivotTo(CFrame.new(table.unpack(cmd.pivot))) end) end
		end
	end
	return { ok = true, created = created, info = info }
end

------------------------------------------------------------------ playtest
local function testService()
	local ok, sts = pcall(game.GetService, game, "StudioTestService")
	if ok then return sts end
	return nil
end

local function doPlay(action)
	local sts = testService()
	if action == "run" or action == "test" then
		if RunService:IsRunning() then return { ok = false, error = "já tem um teste rodando (play stop primeiro)" } end
		if not sts then return { ok = false, error = "StudioTestService indisponível nesta versão do Studio" } end
		-- Os dois rodam numa CÓPIA do place (como os botões do Studio): nada do teste fica no place.
		local method = action == "run" and "ExecuteRunModeAsync" or "ExecutePlayModeAsync"
		task.spawn(function()
			local okRun, err = pcall(function() return sts[method](sts, {}) end)
			if not okRun then say(method .. " falhou: " .. tostring(err)) end
		end)
		return { ok = true, output = {
			action == "run" and "Run iniciado (sem jogador). Use --target server pra executar código nele."
				or "Play iniciado (com jogador). Use --target server ou --target client.",
		} }
	elseif action == "stop" or action == "endtest" then
		if ROLE == "edit" and not RunService:IsRunning() and action == "stop" then
			return { ok = false, error = "nenhum teste rodando" }
		end
		if not sts then return { ok = false, error = "StudioTestService indisponível; pare manualmente" } end
		local okEnd, err = pcall(sts.EndTest, sts, true)
		if okEnd then return { ok = true, output = { "teste encerrado" } } end
		return { ok = false, error = tostring(err) }
	end
	return { ok = false, error = "ação desconhecida: " .. tostring(action) }
end

------------------------------------------------------------------ sync de scripts (só no modo edição)
local SUFFIX = { Script = ".server.luau", LocalScript = ".client.luau", ModuleScript = ".luau" }
local BAD_CHARS = '[/\\:%*%?"<>|%c]'

local syncRoots = {}
local tracked = {}  -- [script] = arquivo
local owner = {}    -- [arquivo] = script
local conns = {}
local dirty = {}
local lastSent = setmetatable({}, { __mode = "k" })
local warned = {}

local function validName(n)
	return n ~= "" and not string.find(n, BAD_CHARS) and not string.find(n, "[%. ]$")
end

local function fileOf(s)
	local suffix = SUFFIX[s.ClassName]
	if not suffix then return nil end
	local parts = {}
	local cur = s
	while cur and not syncRoots[cur] do
		if not validName(cur.Name) then return nil, "nome inválido pra arquivo: " .. instPath(cur) end
		table.insert(parts, 1, cur.Name)
		cur = cur.Parent
	end
	if not cur then return nil end
	table.insert(parts, 1, cur.Name)
	parts[#parts] ..= suffix
	return table.concat(parts, "/")
end

local function parseFile(file)
	if string.sub(file, -12) == ".server.luau" then return "Script", string.split(string.sub(file, 1, -13), "/") end
	if string.sub(file, -12) == ".client.luau" then return "LocalScript", string.split(string.sub(file, 1, -13), "/") end
	if string.sub(file, -5) == ".luau" then return "ModuleScript", string.split(string.sub(file, 1, -6), "/") end
	return nil
end

local function editorSource(s)
	local ok, src = pcall(ScriptEditorService.GetEditorSource, ScriptEditorService, s)
	if ok and type(src) == "string" then return src end
	return s.Source
end

local function warnOnce(key, msg)
	if warned[key] then return end
	warned[key] = true
	say(msg)
end

local function track(s, initial)
	if tracked[s] or not SUFFIX[s.ClassName] then return nil end
	local file, err = fileOf(s)
	if not file then
		if err then warnOnce(err, err .. " (não sincroniza)") end
		return nil
	end
	if owner[file] and owner[file] ~= s then
		warnOnce(file, "dois scripts com o mesmo caminho, só o primeiro sincroniza: " .. file)
		return nil
	end
	tracked[s] = file
	owner[file] = s
	conns[s] = s:GetPropertyChangedSignal("Source"):Connect(function() dirty[s] = true end)
	if initial then
		lastSent[s] = editorSource(s)
	else
		dirty[s] = true
	end
	return file
end

local function untrack(s, sendDelete)
	local file = tracked[s]
	if not file then return end
	tracked[s] = nil
	if owner[file] == s then owner[file] = nil end
	if conns[s] then conns[s]:Disconnect(); conns[s] = nil end
	lastSent[s] = nil
	dirty[s] = nil
	if sendDelete and connected then request("POST", "/sync", { type = "delete", file = file }) end
end

local function sendSnapshot()
	for s in pairs(tracked) do untrack(s, false) end
	local scripts = {}
	for root in pairs(syncRoots) do
		for _, d in ipairs(root:GetDescendants()) do
			if SUFFIX[d.ClassName] then
				local file = track(d, true)
				if file then table.insert(scripts, { file = file, source = lastSent[d] }) end
			end
		end
	end
	local res, err = request("POST", "/snapshot", { scripts = scripts })
	if res then
		local ask = type(res) == "table" and type(res.perguntar) == "table" and #res.perguntar > 0 and res.perguntar or nil
		state.pending = ask -- o painel abre e pergunta
		say(("sincronizado: %d scripts"):format(#scripts) .. (ask and (" | %d diferentes entre Studio e disco: escolha no painel"):format(#ask) or ""))
		return { ok = true, scripts = #scripts, esperandoEscolha = ask and #ask or nil }
	end
	return { ok = false, error = "snapshot falhou: " .. tostring(err) }
end

-- choice: "disco" ou "studio". Manda a versão atual do Studio (pode ter mudado enquanto o painel esperava).
local function resolvePending(choice)
	local list = state.pending
	if not list then return end
	state.pending = nil
	local files = {}
	for _, it in ipairs(list) do
		local s = owner[it.file]
		table.insert(files, { file = it.file, source = s and editorSource(s) or nil })
	end
	local res, err = request("POST", "/resolve", { choice = choice, files = files })
	if res then
		say(("%d scripts: %s"):format(#files, choice == "studio" and "mantida a versão do Studio" or "usada a versão do disco") .. " (a outra está em .bridge/backup)")
	else
		say("não consegui mandar a escolha (" .. tostring(err) .. "); vai perguntar de novo ao reconectar")
	end
end

local function findScript(parent, leaf)
	for _, c in ipairs(parent:GetChildren()) do
		if c.Name == leaf and c:IsA("LuaSourceContainer") then return c end
	end
	return nil
end

local function locateParent(segs, create)
	local ok, cur = pcall(game.GetService, game, segs[1])
	if not ok or not syncRoots[cur] then return nil, "serviço não sincronizado: " .. tostring(segs[1]) end
	for i = 2, #segs - 1 do
		local nxt = cur:FindFirstChild(segs[i])
		if not nxt then
			if not create then return nil end
			nxt = Instance.new("Folder")
			nxt.Name = segs[i]
			nxt.Parent = cur
		end
		cur = nxt
	end
	return cur
end

local function applyWrite(file, src)
	local cls, segs = parseFile(file)
	if not cls then return { ok = false, error = "extensão desconhecida: " .. file } end
	local rec = beginRec("Claude sync: " .. file)
	local parent, err = locateParent(segs, true)
	if not parent then endRec(rec); return { ok = false, error = err } end
	local leaf = segs[#segs]
	local s = findScript(parent, leaf)
	if s then
		lastSent[s] = src
		local ok = pcall(function()
			ScriptEditorService:UpdateSourceAsync(s, function() return src end)
		end)
		if not ok then s.Source = src end
	else
		s = Instance.new(cls)
		s.Name = leaf
		s.Source = src
		lastSent[s] = src
		s.Parent = parent
	end
	endRec(rec)
	return { ok = true }
end

local function applyDelete(file)
	local cls, segs = parseFile(file)
	if not cls then return { ok = false } end
	local parent = locateParent(segs, false)
	local s = parent and findScript(parent, segs[#segs])
	if s then
		local rec = beginRec("Claude sync: apagar " .. file)
		s.Parent = nil
		endRec(rec)
	end
	return { ok = true }
end

local function syncActive()
	return ROLE == "edit" and enabled and connected and not RunService:IsRunning()
end

if ROLE == "edit" then
	for _, name in ipairs(SYNC_SERVICES) do
		local ok, svc = pcall(game.GetService, game, name)
		if ok and svc then
			syncRoots[svc] = true
			svc.DescendantAdded:Connect(function(d)
				if syncActive() and SUFFIX[d.ClassName] then track(d, false) end
			end)
			svc.DescendantRemoving:Connect(function(d)
				if syncActive() and tracked[d] then untrack(d, true) end
			end)
		end
	end

	-- envia edições feitas no Studio (debounce) e detecta renomear/mover
	task.spawn(function()
		local tick = 0
		local wasRunning = false
		while alive do
			task.wait(0.3)
			tick += 1
			local running = RunService:IsRunning()
			if wasRunning and not running and connected and enabled then
				task.wait(1)
				sendSnapshot()
			end
			wasRunning = running
			if syncActive() then
				for s in pairs(dirty) do
					dirty[s] = nil
					local file = tracked[s]
					if file then
						local src = editorSource(s)
						if lastSent[s] ~= src then
							lastSent[s] = src
							request("POST", "/sync", { type = "write", file = file, source = src })
						end
					end
				end
				if tick % 5 == 0 then
					local list = {}
					for s, file in pairs(tracked) do table.insert(list, { s, file }) end
					for _, item in ipairs(list) do
						local s, file = item[1], item[2]
						local nf = s.Parent and fileOf(s) or nil
						if nf ~= file then
							untrack(s, true)
							if nf then track(s, false) end
						end
					end
				end
			end
		end
	end)

	ScriptEditorService.TextDocumentDidChange:Connect(function(doc)
		local ok, s = pcall(doc.GetScript, doc)
		if ok and s and tracked[s] then dirty[s] = true end
	end)
end

------------------------------------------------------------------ Output → servidor
local logBuf = {}
local clientBuf = {} -- no server: o que o client mandou, esperando o server conectar no bridge
-- no Play o plugin carrega depois dos scripts do jogo: o que saiu antes (ex.: erro na largada) só está no histórico.
-- Lido e conectado sem yield no meio, então nada entra duas vezes; o atributo evita reenviar se o plugin recarregar.
if ROLE ~= "edit" and not LogService:GetAttribute("StudioLinkSeeded") then
	pcall(LogService.SetAttribute, LogService, "StudioLinkSeeded", true)
	for _, e in ipairs(LogService:GetLogHistory()) do
		if #logBuf >= 500 then break end
		table.insert(logBuf, { kind = e.messageType.Name, msg = e.message })
	end
end
LogService.MessageOut:Connect(function(msg, mtype)
	if #logBuf < 500 then table.insert(logBuf, { kind = mtype.Name, msg = msg }) end
end)
task.spawn(function()
	while alive do
		task.wait(0.5)
		if ROLE == "client" then
			if relayLog and #logBuf > 0 then
				local batch = logBuf
				logBuf = {}
				pcall(relayLog.FireServer, relayLog, batch)
			end
		elseif connected then
			if #logBuf > 0 then
				local batch = logBuf
				logBuf = {}
				request("POST", "/log", { role = ROLE, entries = batch })
			end
			if #clientBuf > 0 then
				local batch = clientBuf
				clientBuf = {}
				request("POST", "/log", { role = "client", entries = batch })
			end
		end
	end
end)

------------------------------------------------------------------ comandos
local function handle(cmd)
	if cmd.relay == "client" then
		if ROLE ~= "server" or not relayFn then return { ok = false, error = "relay pro client indisponível" } end
		local players = game:GetService("Players")
		local plr = (cmd.player and players:FindFirstChild(cmd.player)) or players:GetPlayers()[1]
		if not plr then return { ok = false, error = "nenhum jogador no playtest ainda" } end
		cmd.relay = nil
		local ok, res = pcall(relayFn.InvokeClient, relayFn, plr, cmd)
		if not ok then return { ok = false, error = "client não respondeu: " .. tostring(res) } end
		return res
	end
	local t = cmd.type
	if t == "run" then return runCode(cmd.code, cmd.name) end
	if t == "tree" then
		local inst, err = resolve(cmd.path)
		if not inst then return { ok = false, error = err } end
		return { ok = true, text = tree(inst, cmd.depth) }
	end
	if t == "play" then return doPlay(cmd.action) end
	if t == "audit_ui" then return Fuzz.auditUI() end
	if t == "audit_world" then return Fuzz.auditWorld() end
	if t == "fuzz_input" then return Fuzz.input(cmd) end
	if t == "insert" then return Fuzz.insert(cmd) end
	if t == "create" then return Obj.create(cmd) end
	if t == "set" then return Obj.set(cmd) end
	if t == "get" then return Obj.get(cmd) end
	if t == "delete" then return Obj.delete(cmd) end
	if t == "clone" then return Obj.clone(cmd) end
	if ROLE == "edit" then
		if t == "write" then return applyWrite(cmd.file, cmd.source) end
		if t == "delete" then return applyDelete(cmd.file) end
		if t == "snapshot" then return sendSnapshot() end
	end
	return { ok = false, error = "comando desconhecido aqui (" .. ROLE .. "): " .. tostring(t) }
end

local work = {}
task.spawn(function()
	while alive do
		local cmd = table.remove(work, 1)
		if not cmd then
			task.wait(0.03)
		else
			state.lastCmd = cmd.type == "run" and ("run " .. tostring(cmd.name or "")) or tostring(cmd.type) .. (cmd.file and (" " .. cmd.file) or "")
			state.lastCmdAt = os.clock()
			local function exec()
				local ok, res = pcall(handle, cmd)
				if not ok then res = { ok = false, error = tostring(res) } end
				if cmd.reply then request("POST", "/result", { id = cmd.id, result = res }) end
			end
			-- sync de arquivos em ordem; o resto em paralelo (um comando travado não segura os outros)
			if cmd.type == "write" or cmd.type == "delete" or cmd.type == "snapshot" then
				exec()
			else
				task.spawn(exec)
			end
		end
	end
end)

local fails = 0
if ROLE ~= "client" then task.spawn(function()
	while alive do
		if not enabled then
			if connected then connected = false end
			task.wait(1)
			continue
		end
		local cmds, perr, status = request("GET", ("/poll?role=%s&sid=%s&place=%s"):format(ROLE, SID, HttpService:UrlEncode(game.Name)))
		if status == 409 then
			-- outra janela do Studio já usa esse servidor
			local okJ, body = pcall(HttpService.JSONDecode, HttpService, string.match(perr, "^%d+ (.*)$") or "")
			if not state.conflict then say("porta " .. port .. " já está sendo usada por outra janela do Studio") end
			state.conflict = okJ and body.place or "outra janela"
			if connected then connected = false end
			task.wait(3)
			continue
		end
		state.conflict = nil
		if cmds == nil then
			state.lastError = perr
			fails += 1
			if connected and fails >= 3 then
				connected = false
				say("desconectado do server.js")
			end
			task.wait(connected and 0.2 or 2)
		else
			fails = 0
			if not connected then
				connected = true
				say("conectado (" .. ROLE .. ")")
				if ROLE == "edit" then task.spawn(sendSnapshot) end
			end
			if type(cmds) == "table" then
				for _, c in ipairs(cmds) do table.insert(work, c) end
			end
		end
	end
end) end

------------------------------------------------------------------ relay server <-> client (client não pode fazer HTTP)
local RELAY_NAME, LOG_NAME = "__StudioLinkRelay", "__StudioLinkLog"
if ROLE == "server" then
	local rs = game:GetService("ReplicatedStorage")
	for _, n in ipairs({ RELAY_NAME, LOG_NAME }) do
		local old = rs:FindFirstChild(n)
		while old do old:Destroy(); old = rs:FindFirstChild(n) end
	end
	relayFn = Instance.new("RemoteFunction")
	relayFn.Name = RELAY_NAME
	relayFn.Archivable = false
	relayFn.Parent = rs
	relayLog = Instance.new("RemoteEvent")
	relayLog.Name = LOG_NAME
	relayLog.Archivable = false
	relayLog.Parent = rs
	-- o 1º lote do client (com os erros da largada) costuma chegar antes do server conectar: guarda em vez de descartar
	relayLog.OnServerEvent:Connect(function(_, batch)
		if type(batch) ~= "table" then return end
		for _, e in ipairs(batch) do
			if #clientBuf >= 500 then break end
			table.insert(clientBuf, e)
		end
	end)
elseif ROLE == "client" then
	local rs = game:GetService("ReplicatedStorage")
	local function bind(child)
		if child.Name == RELAY_NAME and child:IsA("RemoteFunction") then
			child.OnClientInvoke = function(cmd)
				local ok, res = pcall(handle, cmd)
				if not ok then res = { ok = false, error = tostring(res) } end
				return res
			end
			say("client pronto (via server)")
		elseif child.Name == LOG_NAME and child:IsA("RemoteEvent") then
			relayLog = child
		end
	end
	rs.ChildAdded:Connect(bind) -- o server recria quando o plugin recarrega
	for _, c in ipairs(rs:GetChildren()) do bind(c) end
end

------------------------------------------------------------------ painel (só no modo edição)
local function bye()
	if connected then request("POST", "/bye", { role = ROLE, sid = SID }) end
	connected = false
end

local function setEnabled(v)
	if v == enabled then return end
	enabled = v
	savePlace()
	if not v then
		state.conflict, state.info = nil, nil
		task.spawn(bye)
		say("desconectado")
	else
		say("conectando em localhost:" .. port)
	end
end

local function setPort(p)
	p = tonumber(p)
	if not p or p < 1024 or p > 65535 or p % 1 ~= 0 or p == port then return false end
	local was = enabled
	if was then bye() end
	port = p
	state.conflict, state.info = nil, nil
	savePlace()
	if was then say("trocando pra porta " .. port) end
	return true
end

-- B.link(porta): liga este place em outro servidor por código (ex.: projeto novo). A troca acontece
-- logo depois de responder, pra resposta ainda ir pro servidor atual.
function B.link(p)
	p = tonumber(p)
	if not p or p < 1024 or p > 65535 then error("porta inválida", 2) end
	task.delay(0.5, function()
		setPort(p)
		if not enabled then setEnabled(true) end
	end)
	return "trocando pra porta " .. p
end

if ROLE == "edit" then
	local SC = Enum.StudioStyleGuideColor
	local studio = settings().Studio
	local function tc(c) return studio.Theme:GetColor(c) end
	local ACCENT = Color3.fromRGB(217, 119, 87)
	local GREEN = Color3.fromRGB(48, 194, 104)
	local YELLOW = Color3.fromRGB(245, 176, 40)
	local RED = Color3.fromRGB(235, 87, 87)
	local GRAY = Color3.fromRGB(140, 140, 146)
	local WHITE = Color3.new(1, 1, 1)

	local themed = {}
	local function theme(inst, prop, c) table.insert(themed, { inst, prop, c }); inst[prop] = tc(c) end
	studio.ThemeChanged:Connect(function()
		for _, t in ipairs(themed) do t[1][t[2]] = tc(t[3]) end
	end)

	local function new(class, props, children)
		local i = Instance.new(class)
		for k, v in pairs(props or {}) do i[k] = v end
		for _, c in ipairs(children or {}) do c.Parent = i end
		return i
	end
	local function corner(r) return new("UICorner", { CornerRadius = UDim.new(0, r) }) end
	local function stroke()
		local st = new("UIStroke", { Thickness = 1, ApplyStrokeMode = Enum.ApplyStrokeMode.Border })
		theme(st, "Color", SC.Border)
		return st
	end
	local function pad(px)
		return new("UIPadding", { PaddingTop = UDim.new(0, px), PaddingBottom = UDim.new(0, px), PaddingLeft = UDim.new(0, px), PaddingRight = UDim.new(0, px) })
	end
	local function label(props)
		local l = new("TextLabel", {
			BackgroundTransparency = 1, Font = props.bold and Enum.Font.GothamBold or Enum.Font.Gotham,
			TextSize = props.size or 13, TextXAlignment = props.align or Enum.TextXAlignment.Left,
			Text = props.text or "", Size = props.sizeUDim or UDim2.new(1, 0, 0, (props.size or 13) + 6),
			Position = props.pos or UDim2.new(), TextTruncate = Enum.TextTruncate.AtEnd, LayoutOrder = props.order or 0,
		})
		theme(l, "TextColor3", props.dim and SC.DimmedText or SC.MainText)
		return l
	end

	local widget
	local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 320, 460, 260, 320)
	local okW, w = pcall(function() return plugin:CreateDockWidgetPluginGuiAsync("StudioLinkPanel", info) end)
	widget = okW and w or plugin:CreateDockWidgetPluginGui("StudioLinkPanel", info)
	widget.Title = "StudioLink"
	widget.Name = "StudioLinkPanel"

	local root = new("ScrollingFrame", {
		Size = UDim2.fromScale(1, 1), BorderSizePixel = 0, ScrollBarThickness = 4,
		CanvasSize = UDim2.new(), AutomaticCanvasSize = Enum.AutomaticSize.Y, Parent = widget,
	}, {
		new("UIListLayout", { Padding = UDim.new(0, 10), SortOrder = Enum.SortOrder.LayoutOrder }),
		pad(12),
	})
	theme(root, "BackgroundColor3", SC.MainBackground)
	theme(root, "ScrollBarImageColor3", SC.ScrollBar)

	-- cabeçalho
	local header = new("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 40), LayoutOrder = 1, Parent = root })
	-- logo: bloco azul com furo (Studio) e o anel do Claude passando pelo furo
	local logo = new("Frame", { Size = UDim2.fromOffset(32, 32), Position = UDim2.fromOffset(0, 4), BackgroundColor3 = Color3.fromRGB(18, 20, 28), Parent = header }, { corner(8) })
	local tile = new("Frame", { AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromOffset(12, 16), Size = UDim2.fromOffset(16, 16), Rotation = 15,
		BackgroundColor3 = Color3.fromRGB(30, 150, 245), Parent = logo }, { corner(4) })
	new("Frame", { AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.5), Size = UDim2.fromOffset(7, 7),
		BackgroundColor3 = Color3.fromRGB(18, 20, 28), Parent = tile }, { corner(1) })
	new("Frame", { AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromOffset(19, 16), Size = UDim2.fromOffset(14, 14), ZIndex = 2,
		BackgroundTransparency = 1, Parent = logo }, { new("UICorner", { CornerRadius = UDim.new(0.5, 0) }), new("UIStroke", { Color = ACCENT, Thickness = 3 }) })
	local title = label({ text = "StudioLink", bold = true, size = 17, pos = UDim2.fromOffset(42, 2), sizeUDim = UDim2.new(1, -42, 0, 20) })
	title.Parent = header
	local sub = label({ text = "Ponte com o Claude Code  ·  v" .. VERSION, dim = true, size = 12, pos = UDim2.fromOffset(42, 22), sizeUDim = UDim2.new(1, -42, 0, 16) })
	sub.Parent = header

	-- cartão de status
	local card = new("Frame", { Size = UDim2.new(1, 0, 0, 64), LayoutOrder = 2, Parent = root }, { corner(8), stroke() })
	theme(card, "BackgroundColor3", SC.InputFieldBackground)
	local dot = new("Frame", { Size = UDim2.fromOffset(12, 12), Position = UDim2.new(0, 16, 0.5, -6), BackgroundColor3 = GRAY, Parent = card }, { corner(6) })
	local halo = new("UIStroke", { Thickness = 3, Transparency = 0.7, Color = GRAY, Parent = dot })
	local stTitle = label({ text = "", bold = true, size = 15, pos = UDim2.fromOffset(40, 12), sizeUDim = UDim2.new(1, -52, 0, 20) })
	stTitle.Parent = card
	local stDetail = label({ text = "", dim = true, size = 12, pos = UDim2.fromOffset(40, 34), sizeUDim = UDim2.new(1, -52, 0, 16) })
	stDetail.Parent = card

	-- botão principal
	local btn = new("TextButton", {
		Size = UDim2.new(1, 0, 0, 38), LayoutOrder = 3, Font = Enum.Font.GothamBold, TextSize = 14,
		AutoButtonColor = true, BackgroundColor3 = ACCENT, TextColor3 = WHITE, Text = "Conectar", Parent = root,
	}, { corner(8) })
	btn.Activated:Connect(function() setEnabled(not enabled) end)

	-- porta
	local portRow = new("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 30), LayoutOrder = 4, Parent = root })
	local pl = label({ text = "Porta do servidor", size = 13, pos = UDim2.fromOffset(0, 6), sizeUDim = UDim2.new(1, -110, 0, 18) })
	pl.Parent = portRow
	local portBox = new("TextBox", {
		Size = UDim2.new(0, 100, 1, 0), Position = UDim2.new(1, -100, 0, 0), Font = Enum.Font.Code, TextSize = 14,
		Text = tostring(port), ClearTextOnFocus = false, Parent = portRow,
	}, { corner(6), stroke() })
	theme(portBox, "BackgroundColor3", SC.InputFieldBackground)
	theme(portBox, "TextColor3", SC.MainText)
	portBox.FocusLost:Connect(function()
		if not setPort(portBox.Text) then portBox.Text = tostring(port) end
	end)

	-- informações
	local infoCard = new("Frame", { Size = UDim2.new(1, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, LayoutOrder = 5, Parent = root }, {
		corner(8), stroke(), pad(12), new("UIListLayout", { Padding = UDim.new(0, 8), SortOrder = Enum.SortOrder.LayoutOrder }),
	})
	theme(infoCard, "BackgroundColor3", SC.InputFieldBackground)
	local rows = {}
	local function row(i, name)
		local f = new("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 18), LayoutOrder = i, Parent = infoCard })
		label({ text = name, dim = true, size = 12, sizeUDim = UDim2.new(0, 96, 1, 0) }).Parent = f
		local v = label({ text = "—", size = 12, pos = UDim2.fromOffset(100, 0), sizeUDim = UDim2.new(1, -100, 1, 0), align = Enum.TextXAlignment.Right })
		v.Parent = f
		rows[name] = v
	end
	for i, n in ipairs({ "Projeto", "Pasta", "Place", "Scripts", "Playtest", "Último comando" }) do row(i, n) end

	-- ajuda
	local help = label({ text = "", dim = true, size = 12, order = 6, sizeUDim = UDim2.new(1, 0, 0, 0) })
	help.TextWrapped = true
	help.TextTruncate = Enum.TextTruncate.None
	help.AutomaticSize = Enum.AutomaticSize.Y
	help.Parent = root

	-- Studio e disco diferentes na reconexão: quem escolhe é a pessoa, aqui no Studio (com mais gente no place o código não adivinha)
	local ask = new("Frame", { Size = UDim2.new(1, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, LayoutOrder = 0, Visible = false, Parent = root }, {
		corner(8), pad(12), new("UIStroke", { Thickness = 2, Color = YELLOW }),
		new("UIListLayout", { Padding = UDim.new(0, 8), SortOrder = Enum.SortOrder.LayoutOrder }),
	})
	theme(ask, "BackgroundColor3", SC.InputFieldBackground)
	label({ text = "Studio e disco estão diferentes", bold = true, size = 14, order = 1 }).Parent = ask
	local askList = label({ text = "", dim = true, size = 12, order = 2, sizeUDim = UDim2.new(1, 0, 0, 0) })
	askList.TextWrapped = true
	askList.TextTruncate = Enum.TextTruncate.None
	askList.AutomaticSize = Enum.AutomaticSize.Y
	askList.Parent = ask
	local askBtns = new("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 34), LayoutOrder = 3, Parent = ask })
	for i, opt in ipairs({ { "Usar o disco", "disco" }, { "Manter o Studio", "studio" } }) do
		local b = new("TextButton", {
			Size = UDim2.new(0.5, -4, 1, 0), Position = UDim2.new((i - 1) * 0.5, (i - 1) * 4, 0, 0), Font = Enum.Font.GothamBold,
			TextSize = 13, AutoButtonColor = true, Text = opt[1], Parent = askBtns,
		}, { corner(8) })
		theme(b, "BackgroundColor3", SC.Button)
		theme(b, "TextColor3", SC.ButtonText)
		b.Activated:Connect(function()
			ask.Visible = false
			resolvePending(opt[2])
		end)
	end
	local askShown, askOpened
	local function renderAsk()
		ask.Visible = state.pending ~= nil
		if state.pending == askShown then return end
		askShown = state.pending
		if not askShown then return end
		local lines = { "Esses scripts mudaram no Studio desde o último sync. Escolha qual versão fica; a outra vai pra .bridge/backup. Até escolher, eles não sincronizam.", "" }
		for i, it in ipairs(askShown) do
			if i > 12 then table.insert(lines, ("+ %d outros"):format(#askShown - 12)) break end
			table.insert(lines, "• " .. it.file .. (it.velho and "  (Studio com versão antiga)" or ""))
		end
		askList.Text = table.concat(lines, "\n")
	end

	local function ago(t)
		local d = math.floor(os.clock() - t)
		if d < 60 then return d .. "s atrás" end
		return math.floor(d / 60) .. " min atrás"
	end
	local function count(t) local n = 0 for _ in pairs(t) do n += 1 end return n end

	local function render()
		local color, t, d
		if not enabled then
			color, t, d = GRAY, "Desconectado", "Clique em Conectar pra ligar este place"
		elseif state.conflict then
			color, t, d = RED, "Porta em uso", "\"" .. tostring(state.conflict) .. "\" já está em localhost:" .. port
		elseif not connected then
			color, t, d = YELLOW, "Procurando servidor…", "localhost:" .. port
		else
			color, t, d = GREEN, "Conectado", "localhost:" .. port
		end
		renderAsk()
		dot.BackgroundColor3 = color
		halo.Color = color
		stTitle.Text = t
		stDetail.Text = d

		if enabled then
			btn.Text = connected and "Desconectar" or "Cancelar"
			btn.BackgroundColor3 = tc(SC.Button)
			btn.TextColor3 = tc(SC.ButtonText)
		else
			btn.Text = "Conectar"
			btn.BackgroundColor3 = ACCENT
			btn.TextColor3 = WHITE
		end
		if not portBox:IsFocused() then portBox.Text = tostring(port) end

		local i = state.info
		rows["Projeto"].Text = (connected and i and i.name) or "—"
		rows["Pasta"].Text = (connected and i and i.root) or "—"
		rows["Place"].Text = game.Name
		rows["Scripts"].Text = connected and (tostring(count(tracked)) .. " sincronizados") or "—"
		rows["Playtest"].Text = (connected and i and i.playtest) and "rodando" or (connected and "parado" or "—")
		rows["Último comando"].Text = state.lastCmd and (state.lastCmd .. " · " .. ago(state.lastCmdAt)) or "—"

		if not enabled then
			help.Text = "Cada place guarda a própria porta. Pra usar vários Studios ao mesmo tempo, rode \"studiolink start\" em cada projeto, cada um numa porta (studiolink.json), e ponha a porta certa aqui."
		elseif state.conflict then
			help.Text = "Outra janela do Studio já está ligada nesse servidor. Desconecte ela ou use a porta de outro projeto."
		elseif not connected then
			help.Text = "Rode \"studiolink start\" na pasta do projeto. A porta está no studiolink.json do projeto (padrão 34880)."
		else
			help.Text = "Scripts sincronizados com " .. ((i and i.root) or "a pasta do projeto") .. "\\src. O Claude Code já pode controlar este Studio."
		end
	end

	task.spawn(function()
		local n = 0
		while alive do
			if connected and (n % 5 == 0 or not state.info) then
				local data = request("GET", "/info")
				if type(data) == "table" then state.info = data end
			end
			if state.pending and state.pending ~= askOpened then askOpened = state.pending; widget.Enabled = true end -- abre o painel pra perguntar
			if widget.Enabled then pcall(render) end
			n += 1
			task.wait(1)
		end
	end)

	local toolbar = plugin:CreateToolbar("StudioLink")
	local button = toolbar:CreateButton("StudioLinkPanel", "Abre o painel do StudioLink", "", "StudioLink")
	button.ClickableWhenViewportHidden = true
	button:SetActive(widget.Enabled)
	button.Click:Connect(function() widget.Enabled = not widget.Enabled end)
	widget:GetPropertyChangedSignal("Enabled"):Connect(function()
		button:SetActive(widget.Enabled)
		if widget.Enabled then pcall(render) end
	end)
	pcall(render)
end

plugin.Unloading:Connect(function()
	alive = false
	if connected then task.spawn(request, "POST", "/bye", { role = ROLE, sid = SID }) end
	if ROLE == "server" then
		if relayFn then pcall(relayFn.Destroy, relayFn) end
		if relayLog then pcall(relayLog.Destroy, relayLog) end
	end
end)
