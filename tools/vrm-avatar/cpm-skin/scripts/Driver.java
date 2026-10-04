import java.io.*;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import com.tom.cpl.util.Image;
import com.tom.cpl.util.ImageIO.IImageIO;
import com.tom.cpl.math.Vec2i;
import com.tom.cpl.config.ModConfigFile;
import com.tom.cpm.shared.*;
import com.tom.cpm.shared.config.Player;
import com.tom.cpm.shared.definition.ModelDefinitionLoader;
import com.tom.cpm.shared.editor.Editor;
import com.tom.cpm.shared.editor.Exporter;
import com.tom.cpm.shared.model.SkinType;
import com.tom.cpm.shared.skin.PlayerTextureLoader;
import com.tom.cpl.gui.UI;

public class Driver {
	static class AwtIO implements IImageIO {
		public Image read(File f) throws IOException { try(InputStream i = new FileInputStream(f)) { return read(i); } }
		public Image read(InputStream f) throws IOException {
			java.awt.image.BufferedImage b = javax.imageio.ImageIO.read(f);
			Image img = new Image(b.getWidth(), b.getHeight());
			for(int y=0;y<b.getHeight();y++)for(int x=0;x<b.getWidth();x++)img.setRGB(x,y,b.getRGB(x,y));
			return img;
		}
		public void write(Image img, File f) throws IOException { try(OutputStream o = new FileOutputStream(f)) { write(img, o); } }
		public void write(Image img, OutputStream o) throws IOException {
			java.awt.image.BufferedImage b = new java.awt.image.BufferedImage(img.getWidth(), img.getHeight(), java.awt.image.BufferedImage.TYPE_INT_ARGB);
			for(int y=0;y<img.getHeight();y++)for(int x=0;x<img.getWidth();x++)b.setRGB(x,y,img.getRGB(x,y));
			javax.imageio.ImageIO.write(b, "png", o);
		}
		public Vec2i getSize(InputStream d) throws IOException { Image i = read(d); return new Vec2i(i.getWidth(), i.getHeight()); }
	}

	static class P extends Player<Object> {
		public SkinType getSkinType() { return SkinType.DEFAULT; }
		protected PlayerTextureLoader initTextures() { return new PlayerTextureLoader() { protected CompletableFuture<Void> load0() { return CompletableFuture.completedFuture(null); } }; }
		public String getName() { return "test"; }
		public UUID getUUID() { return new UUID(0,0); }
		public void updateFromPlayer(com.tom.cpm.shared.animation.AnimationState s, Object p) {}
		public Object getGameProfile() { return null; }
		public void updateFromModel(com.tom.cpm.shared.animation.AnimationState s, Object m) {}
	}

	@SuppressWarnings("unchecked")
	static <T> T proxy(Class<T> c, Map<String, Object> ret) {
		return (T) Proxy.newProxyInstance(Driver.class.getClassLoader(), new Class<?>[]{c}, (pr, m, a) -> {
			if(ret.containsKey(m.getName())) {
				Object v = ret.get(m.getName());
				if(v instanceof java.util.function.Function) return ((java.util.function.Function<Object[],Object>)v).apply(a);
				return v;
			}
			if(m.getName().equals("executeLater") || m.getName().equals("executeOnGameThread")) { ((Runnable)a[0]).run(); return null; }
			if(m.getName().startsWith("i18n")) return String.valueOf(a[0]) + (a.length>1? " " + Arrays.deepToString((Object[])a[1]) : "");
			if(m.getName().startsWith("display") || m.getName().equals("onGuiException")) { System.out.println("UI: " + m.getName() + " " + Arrays.deepToString(a)); if(a!=null) for(Object o:a) if(o instanceof Throwable) ((Throwable)o).printStackTrace(); return null; }
			if(m.isDefault()) return InvocationHandler.invokeDefault(pr, m, a);
			Class<?> r = m.getReturnType();
			if(r == boolean.class) return false; if(r == int.class) return 0; if(r == float.class) return 0f; if(r==long.class) return 0L;
			return null;
		});
	}

	public static void main(String[] args) throws Exception {
		File proj = new File(args[0]), out = new File(args[1]);
		ModConfigFile cfg = new ModConfigFile(File.createTempFile("cpmcfg", ".json"));
		MinecraftCommonAccess common = proxy(MinecraftCommonAccess.class, Map.of("getConfig", cfg, "getLogger", (com.tom.cpl.util.ILogger) proxy(com.tom.cpl.util.ILogger.class, Map.of("info", (java.util.function.Function<Object[],Object>) a -> { System.out.println("LOG " + a[0]); return null; }))));
		ModelDefinitionLoader[] dl = new ModelDefinitionLoader[1];
		P player = new P();
		Map<String,Object> m = new HashMap<>();
		m.put("getImageIO", new AwtIO());
		m.put("getSkinType", SkinType.DEFAULT);
		m.put("getClientPlayer", player);
		m.put("getGameDir", new File("."));
		MinecraftClientAccess client = proxy(MinecraftClientAccess.class, m);
		Field f1 = MinecraftObjectHolder.class.getDeclaredField("commonObject"); f1.setAccessible(true); f1.set(null, common);
		Field f2 = MinecraftObjectHolder.class.getDeclaredField("clientObject"); f2.setAccessible(true); f2.set(null, client);
		dl[0] = new ModelDefinitionLoader<Object>(g -> player, g -> new UUID(0,0), g -> "test");
		m.put("getDefinitionLoader", dl[0]);
		UI ui = proxy(UI.class, new HashMap<>());
		Editor e = new Editor();
		e.setUI(ui);
		e.load(proj).get();
		System.out.println("elements=" + e.elements.size() + " skinType=" + e.skinType);
		Image skin = e.textures.get(com.tom.cpm.shared.model.TextureSheetType.SKIN).getImage();
		e.vanillaSkin = skin;
		e.textures.get(com.tom.cpm.shared.model.TextureSheetType.SKIN).setEdited(false);
		Exporter.exportSkin(e, ui, out, false);
		System.out.println("exported " + out + " exists=" + out.exists());
		Image back = new AwtIO().read(out);
		try(com.tom.cpm.shared.io.SkinDataInputStream in = new com.tom.cpm.shared.io.SkinDataInputStream(back, dl[0].getTemplate(), SkinType.DEFAULT.getChannel())) {
			int h = in.read();
			System.out.println("header=0x" + Integer.toHexString(h) + (h == ModelDefinitionLoader.HEADER ? " OK" : " BAD"));
			com.tom.cpm.shared.io.ChecksumInputStream cis = new com.tom.cpm.shared.io.ChecksumInputStream(in);
			com.tom.cpm.shared.io.IOHelper din = new com.tom.cpm.shared.io.IOHelper(cis);
			while(true) {
				Object[] got = new Object[2];
				din.readObjectBlock(com.tom.cpm.shared.parts.ModelPartType.VALUES, (t, bl) -> {
					got[0] = t;
					if(t == com.tom.cpm.shared.parts.ModelPartType.DEFINITION) { try { got[1] = new com.tom.cpm.shared.parts.ModelPartDefinition(bl, null); } catch (Exception ex) { got[1] = ex; } } else if(t == com.tom.cpm.shared.parts.ModelPartType.CUBES) {
						try { got[1] = new com.tom.cpm.shared.parts.ModelPartCubes(bl, null); } catch (Exception ex) { got[1] = ex; }
					}
					return null;
				});
				System.out.println("block " + got[0] + (got[1] != null ? " -> " + got[1] : ""));
				if(got[0] == com.tom.cpm.shared.parts.ModelPartType.END) { cis.checkSum(); System.out.println("checksum OK"); break; }
			}
		}

	}
}
